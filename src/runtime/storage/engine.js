'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { formatBound } = require('./registry.ts');
const { resolveStorePath } = require('./roots.ts');
const { selectCandidates, recordStillCandidate, protectedLogs, removableRules, ruleOrder, projectRoot } = require('./rules');
const { retainLocked } = require('../lifecycle/store-upkeep');
const { parseWindow, selectExpired } = require('../lifecycle/retention');
const { readEvents } = require('../lifecycle/event-store');
const { createWorkCache } = require('./work-status');
const { projectKey } = require('../lifecycle/report-store');
const SAFE_NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TOMBSTONE = /^\.[A-Za-z0-9][A-Za-z0-9._-]*\.pruning-[0-9]+-[0-9a-f]{8}$/;

function stat(fsImpl,file) { try { return fsImpl.lstatSync(file); } catch { return null; } }
function ownedPathLinked(store,roots,fsImpl) {
  const root=roots[store.root]; if (!root) return false;
  const owned=path.basename(root)==='doflow' || path.basename(root)==='.doflow' ? root : path.dirname(root);
  for (const dir of [owned,...(store.path ? [root,...store.path.split('/').reduce((a,part)=>{a.push(path.join(a.at(-1)||root,part));return a;},[])] : [root])])
    if (stat(fsImpl,dir)?.isSymbolicLink()) return true;
  return false;
}
function inventory(store,storeDir,fsImpl,shouldStop) {
  const match=new RegExp(store.match), entries=[];
  for (const name of fsImpl.readdirSync(storeDir)) {
    if (shouldStop?.()) return null;
    const matches=match.test(name), namespace=store.entry==='record' && SAFE_NAMESPACE.test(name) && !name.includes('..');
    if (!matches && !namespace) continue;
    const info=stat(fsImpl,path.join(storeDir,name));
    if (shouldStop?.()) return null;
    if (!info || info.isSymbolicLink()) continue;
    if (store.entry==='dir' && !info.isDirectory() || store.entry==='file' && !info.isFile()
      || store.entry==='record' && !(matches && info.isFile() || namespace && info.isDirectory())) continue;
    entries.push({name,stat:info});
  }
  return entries;
}
function sweepTombstones(fsImpl,storeDir,row) {
  for (const name of fsImpl.readdirSync(storeDir)) {
    if (!TOMBSTONE.test(name)) continue;
    const target=path.join(storeDir,name);
    try {
      const info=fsImpl.lstatSync(target);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      // Node's recursive rm removes nested links themselves, never their referents.
      fsImpl.rmSync(target,{recursive:true});
      row.removed++;
    } catch (error) {
      if (error.code==='ENOENT') row.removed++;
      else row.failed.push({name,code:error.code || 'EIO'});
    }
  }
}
function removalOrder(candidates) {
  const oldest=[...candidates].sort((a,b)=>a.mtimeMs-b.mtimeMs || a.name.localeCompare(b.name));
  const byName=new Map(oldest.map(candidate=>[candidate.name,candidate])), emitted=new Set(), ordered=[];
  for (const candidate of oldest) {
    // Preserve oldest-first order except that a task's claims must disappear before its record.
    const claims=byName.get(candidate.name.replace(/\.json$/, '_claims.json'));
    for (const entry of [claims,candidate]) {
      if (entry && !emitted.has(entry.name)) { ordered.push(entry); emitted.add(entry.name); }
    }
  }
  return ordered;
}
function removeOne(fsImpl,storeDir,candidate,store,context) {
  const parts=candidate.name.split('/');
  if (parts.length>2 || parts.some(part=>!part || part==='.' || part==='..')) throw Object.assign(new Error('unsafe name'),{code:'EINVAL'});
  const target=path.join(storeDir,...parts), lock=`${target}.lock`;
  let locked=false;
  try {
    if (parts.length===2) {
      const parent=fsImpl.lstatSync(path.join(storeDir,parts[0]));
      if (parent.isSymbolicLink() || !parent.isDirectory()) return false;
    }
    if (store.entry==='record') {
      try { fsImpl.mkdirSync(lock); locked=true; }
      catch(error) { if (error.code==='EEXIST') return false; throw error; }
    }
    const info=fsImpl.lstatSync(target);
    if (info.isSymbolicLink()) return false;
    if (locked) {
      if (!recordStillCandidate(store,candidate,info,context)) return false;
      // Some record writers do not honor this lock. Catch a write during the work-status read
      // too; a changed subject must wait for another pass even if it still looks finished.
      const current=fsImpl.lstatSync(target);
      if (current.isSymbolicLink() || !current.isFile()
        || ['mtimeMs','ctimeMs','size','ino','dev'].some(key=>current[key]!==info[key])) return false;
    }
    if (context.shouldStop()) return false;
    if (info.isDirectory()) {
      // An appending hook may have refreshed a child since selection. Revalidate before hiding.
      if (store.rule==='age' && !selectCandidates(store,[{name:candidate.name,stat:info}],context)?.length) return false;
      if (context.shouldStop()) return false;
      const tombstone=path.join(path.dirname(target),`.${path.basename(target)}.pruning-${process.pid}-${randomBytes(4).toString('hex')}`);
      try { fsImpl.renameSync(target,tombstone); } catch { return false; }
      const renamed=fsImpl.lstatSync(tombstone);
      if (!renamed.isDirectory() || renamed.isSymbolicLink()) return false;
      fsImpl.rmSync(tombstone,{recursive:true});
    } else if (info.isFile()) fsImpl.unlinkSync(target);
    else return false;
    return true;
  } catch(error) { if (error.code==='ENOENT') return true; throw error; }
  finally {
    if (locked) {
      try { fsImpl.rmdirSync(lock); } catch(error) { if (error.code!=='ENOENT') throw error; }
    }
  }
}
function cleanEmptyNamespace(fsImpl,storeDir,name,report = false) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return;
  const dir=path.join(storeDir,name);
  try {
    if (report && fsImpl.readdirSync(dir).join() === '.root') fsImpl.unlinkSync(path.join(dir,'.root'));
    fsImpl.rmdirSync(dir);
  } catch { /* another record, or an active writer */ }
}
function projectKeyMarker(fsImpl,storeDir,roots) {
  const project=projectRoot(roots);
  if (!project) return;
  let key;
  try { key=projectKey(project,fsImpl); } catch { return; }
  const dir=path.join(storeDir,key);
  if (!stat(fsImpl,dir)?.isDirectory() || stat(fsImpl,path.join(dir,'.root'))) return;
  try { fsImpl.writeFileSync(path.join(dir,'.root'),`${fsImpl.realpathSync(project)}\n`,{flag:'wx'}); } catch { /* best effort */ }
}
/** A bounded pass over registry-declared stores; report mode never writes. */
function runPass({registry,roots,stores,mode,setting={},now=Date.now(),budgetMs,maxRemovals,env=process.env,fsImpl=fs}) {
  if (mode!=='report' && mode!=='prune') throw new Error('Storage pass mode must be report or prune');
  const started=performance.now(), budget=budgetMs===undefined?(mode==='report'?Infinity:registry.settings.passBudgetMs):budgetMs;
  const cap=maxRemovals===undefined?registry.settings.maxRemovalsPerPass:maxRemovals;
  const requested=new Set(stores || registry.stores.filter(s=>removableRules.has(s.rule)).map(s=>s.id));
  const ordered=[...registry.stores].filter(s=>requested.has(s.id) && removableRules.has(s.rule))
    .sort((a,b)=>ruleOrder.indexOf(a.id)-ruleOrder.indexOf(b.id));
  const result={mode,partial:false,durationMs:0,stores:[]};
  let removals=0, protectedSet=null;
  const shouldStop=()=>mode==='prune' && (removals>=cap || performance.now()-started>=budget);
  const project=projectRoot(roots);
  const workCache=project && ordered.some(s=>s.rule==='work' || s.protect==='open-work')
    ? createWorkCache({projectRoot:project,fsImpl}) : null;
  // P0/P1 run for every requested store before any budgeted inventory or selection. A stopped
  // pass must still finish removing folders that an earlier interrupted pass already hid.
  const ready=[];
  for (const store of ordered) {
    const root=roots[store.root], storeSetting=typeof setting[store.root]==='string'?setting[store.root]:setting[store.root]?.setting || 'on';
    const location=root?path.join(root,...(store.path?store.path.split('/'):[])):'';
    const row={id:store.id,root:root || '',location,bound:formatBound(store),setting:storeSetting,entries:0,bytes:0,selected:[],removed:0,protected:0,failed:[]};
    result.stores.push(row);
    if (!root) { row.skipped='absent'; continue; }
    if (ownedPathLinked(store,roots,fsImpl) || resolveStorePath({store,roots,fsImpl})===null) { row.skipped='link'; continue; }
    if (!stat(fsImpl,root) || !stat(fsImpl,location)?.isDirectory()) { row.skipped='absent'; continue; }
    // IC-013: an explicit DOFLOW_RETENTION_HOURS governs lifecycle events even while pruning is off.
    const explicitWindow=store.rule==='lifecycle-settled' ? parseWindow(env) : {state:'off'};
    if (mode==='prune' && storeSetting==='off' && explicitWindow.state!=='on') { row.skipped='setting-off'; continue; }
    if (mode==='prune') {
      try { sweepTombstones(fsImpl,location,row); }
      catch(error) { row.failed.push({name:store.id,code:error.code || 'EIO'}); continue; }
    }
    ready.push({store,row,location,explicitWindow,storeSetting});
  }
  for (const {store,row,location,explicitWindow,storeSetting} of ready) {
    if (shouldStop()) { result.partial=true; break; }
    let entries;
    try { entries=inventory(store,location,fsImpl,shouldStop); }
    catch(error) { row.failed.push({name:store.id,code:error.code || 'EIO'}); continue; }
    if (entries===null) { result.partial=true; break; }
    row.entries=entries.length;
    for (const entry of entries) {
      if (shouldStop()) { result.partial=true; break; }
      row.bytes+=entry.stat.size;
    }
    if (result.partial) break;
    if (store.rule==='lifecycle-settled') {
      // Report and prune share one window: the env window, else the default only while the setting is on.
      const window=explicitWindow.state==='on' ? {...explicitWindow,source:'env'}
        : explicitWindow.state==='invalid' ? explicitWindow
          : storeSetting==='off' ? {state:'off'}
            : {state:'on',hours:store.bound.defaultHours,ms:store.bound.defaultHours*3600000,source:'default'};
      if (window.state==='on') {
        if (mode==='report') {
          let snapshot;
          try { snapshot=readEvents(project,{fsImpl,lockFallback:false,shouldStop}); }
          catch(error) { row.failed.push({name:store.id,code:error.code || 'EIO'}); continue; }
          if (snapshot.incomplete) { result.partial=true; break; }
          if (snapshot.unreadable.length) { row.failed.push({name:store.id,code:'EIO'}); continue; }
          const selection=selectExpired(snapshot.events,{now:new Date(now),windowMs:window.ms,shouldStop});
          if (selection.incomplete) { result.partial=true; break; }
          row.selected=selection.files.map(name=>({name,reason:'settled',bytes:stat(fsImpl,path.join(location,name))?.size || 0}));
        } else {
          let output;
          try { output=retainLocked(project,{fsImpl,now:new Date(now),window,maxFiles:Math.max(0,cap-removals),shouldStop}); }
          catch(error) { row.failed.push({name:store.id,code:error.code || 'EIO'}); continue; }
          row.selected=output.selected.map(({name,bytes})=>({name,reason:'settled',bytes}));
          row.removed=output.removed; removals+=row.removed;
          if (output.warning.length) row.failed.push({name:store.id,code:output.code || 'EIO'});
          if (output.partial) { result.partial=true; break; }
        }
      }
      if (shouldStop()) { result.partial=true; break; }
      continue;
    }
    let candidates;
    try { candidates=selectCandidates(store,entries,{registry,roots,fsImpl,storeDir:location,now,settings:registry.settings,shouldStop,cache:workCache}); }
    catch(error) {
      if (error.partial) { result.partial=true; break; }
      row.failed.push({name:store.id,code:error.code || 'EIO'}); continue;
    }
    if (candidates===null) { result.partial=true; break; }
    if (store.protect==='open-work' && candidates.length) {
      if (!protectedSet) {
        const protection=protectedLogs({registry,roots,fsImpl,cache:workCache,shouldStop});
        if (protection.incomplete) {
          if (shouldStop()) { result.partial=true; break; }
          row.failed.push({name:store.id,code:protection.reason || 'EIO'}); continue;
        }
        protectedSet=protection.names;
      }
      row.protected=candidates.filter(c=>protectedSet.has(c.name)).length;
      candidates=candidates.filter(c=>!protectedSet.has(c.name));
    }
    const orderedCandidates=store.entry==='record' ? removalOrder(candidates)
      : [...candidates].sort((a,b)=>a.mtimeMs-b.mtimeMs || a.name.localeCompare(b.name));
    if (shouldStop()) { result.partial=true; break; }
    row.selected=orderedCandidates.map(({name,reason,bytes})=>({name,reason,bytes}));
    if (mode==='report') continue;
    if (shouldStop()) { result.partial=true; break; }
    const removalContext={registry,roots,fsImpl,storeDir:location,now,settings:registry.settings,shouldStop,cache:workCache};
    for (const candidate of orderedCandidates) {
      if (shouldStop()) { result.partial=true; break; }
      try {
        if (ownedPathLinked(store,roots,fsImpl) || resolveStorePath({store,roots,fsImpl})===null) continue;
        if (removeOne(fsImpl,location,candidate,store,removalContext)) {
          row.removed++; removals++;
          if (store.entry==='record' && candidate.name.includes('/')) cleanEmptyNamespace(fsImpl,location,candidate.name.split('/')[0]);
          if (store.rule==='report-orphan' && candidate.name.includes('/')) cleanEmptyNamespace(fsImpl,location,candidate.name.split('/')[0],true);
        }
      } catch(error) { row.failed.push({name:candidate.name,code:error.code || 'EIO'}); }
    }
    if (store.rule==='report-orphan' && !result.partial) projectKeyMarker(fsImpl,location,roots);
    if (result.partial) break;
  }
  result.durationMs=performance.now()-started;
  return result;
}
module.exports={runPass};
