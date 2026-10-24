'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const registry = require('../../core/registry/storage.json');
const { runPass } = require('../../src/runtime/storage/engine.ts');
const DAY = 86400000;
const NOW = Date.parse('2026-10-10T12:00:00Z');
function fixture(t) {
  const project = tempDir(t, 'doflow-engine-');
  const home = path.join(project, 'home');
  const roots = Object.fromEntries(Object.entries(registry.roots).map(([id, r]) => [id, path.join(r.base === 'xdg-config' ? path.join(home, '.config') : r.base === 'home' ? home : project, ...r.segments)]));
  return { project, roots, pass: (stores, mode = 'prune', extra = {}) => runPass({ registry, roots, stores, mode, setting: Object.fromEntries(Object.keys(roots).map(id => [id, 'on'])), now: NOW, ...extra }) };
}
function put(dir, name, text = '{}', age = 31) { fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, name); fs.writeFileSync(file, text); fs.utimesSync(file, new Date(NOW - age * DAY), new Date(NOW - age * DAY)); return file; }
function store(f, sub) { return path.join(f.roots['project-state'], sub); }
test('open gate work survives unchanged; terminal 31-day run and idle research expire, 29-day run stays', t => {
  const f = fixture(t);
  const evidence = put(store(f, 'evidence'), 'gate.json', '{"run":"gate"}', 120);
  put(store(f, 'orchestration'), 'gate.json', '{"state":"AWAITING_GATE"}', 120);
  put(store(f, 'orchestration'), 'old.json', JSON.stringify({ state:'COMPLETED', updatedAt: new Date(NOW-31*DAY).toISOString() }), 31);
  put(store(f, 'orchestration'), 'recent.json', JSON.stringify({ state:'COMPLETED', updatedAt: new Date(NOW-29*DAY).toISOString() }), 29);
  put(store(f, 'research'), 'idle.json');
  const before = fs.readFileSync(evidence); const mtime = fs.statSync(evidence).mtimeMs;
  const result = f.pass(['task-evidence','task-research','task-orchestration']);
  assert.deepEqual(result.stores.map(s => s.id), ['task-evidence','task-research','task-orchestration']);
  assert.deepEqual(fs.readFileSync(evidence), before); assert.equal(fs.statSync(evidence).mtimeMs, mtime);
  assert.equal(fs.existsSync(store(f,'orchestration/old.json')),false);
  assert.equal(fs.existsSync(store(f,'orchestration/recent.json')),true);
  assert.equal(fs.existsSync(store(f,'research/idle.json')),false);
  const remaining=[evidence,store(f,'orchestration/gate.json'),store(f,'orchestration/recent.json')];
  const snapshot=remaining.map(file=>[fs.readFileSync(file),fs.statSync(file).mtimeMs]);
  assert.equal(f.pass(['task-evidence','task-research','task-orchestration']).stores.reduce((n,s)=>n+s.removed,0),0);
  remaining.forEach((file,i)=>{assert.deepEqual(fs.readFileSync(file),snapshot[i][0]);assert.equal(fs.statSync(file).mtimeMs,snapshot[i][1]);});
});
test('logs sort by name time, keep newest 40 and protect logs named by open records', t => {
  const f=fixture(t), dir=store(f,'verification/logs');
  for(let i=0;i<43;i++) put(dir, `${String(NOW-(42-i)*3600000)}-case.log`, 'log', 0);
  const protectedName=`${NOW-42*3600000}-case.log`;
  put(store(f,'evidence'),'live.json', JSON.stringify({ log: protectedName }), 120);
  put(store(f,'orchestration'),'live.json','{"state":"RUNNING"}',120);
  const result=f.pass(['verification-logs']).stores[0];
  assert.equal(result.protected,1); assert.equal(result.removed,2);
  assert.equal(fs.existsSync(path.join(dir,protectedName)),true);
  assert.equal(fs.readdirSync(dir).length,41);
});
test('a log inside the newest 40 still expires after 30 days', t => {
  const f=fixture(t), dir=store(f,'verification/logs');
  put(dir,`${NOW-31*DAY}-old.log`,'old');
  put(dir,`${NOW-DAY}-new.log`,'new');
  assert.deepEqual(f.pass(['verification-logs'],'report').stores[0].selected.map(e=>e.name),[`${NOW-31*DAY}-old.log`]);
  assert.equal(f.pass(['verification-logs']).stores[0].removed,1);
});
test('date partitions keep today and future; report selects but does not remove; off skips', t => {
  const f=fixture(t), dir=store(f,'runs');
  for(const name of ['2026-04-01.jsonl','2026-10-10.jsonl','2026-10-11.jsonl']) put(dir,name);
  const report=f.pass(['runs-project'],'report').stores[0];
  assert.deepEqual(report.selected.map(e=>e.name),['2026-04-01.jsonl']); assert.equal(fs.readdirSync(dir).length,3);
  assert.equal(f.pass(['runs-project'],'prune',{ setting: {'project-state':'off'} }).stores[0].skipped,'setting-off');
  assert.equal(f.pass(['runs-project']).stores[0].removed,1);
  assert.deepEqual(fs.readdirSync(dir).sort(),['2026-10-10.jsonl','2026-10-11.jsonl']);
});
test('recovery keeps newest three and ledger id; missing or invalid ledger keeps all', t => {
  const f=fixture(t), dir=store(f,'recovery');
  const names=Array.from({length:5},(_,i)=>`recovery_2026-01-0${i+1}T00-00-00-000Z_a.json`);
  names.forEach(n=>put(dir,n));
  assert.equal(f.pass(['recovery-project']).stores[0].removed,0);
  const ledger=put(f.roots['project-state'],'ledger.json','{bad');
  assert.equal(f.pass(['recovery-project']).stores[0].removed,0);
  fs.writeFileSync(ledger,JSON.stringify({lastRecoveryId:names[0].slice(0,-5)}));
  assert.equal(f.pass(['recovery-project']).stores[0].removed,1);
  assert.deepEqual(fs.readdirSync(dir).sort(),[names[0],...names.slice(2)]);
});
test('age uses newest direct child and work removes stale temp plus empty namespace', t => {
  const f=fixture(t), dir=path.join(f.roots['config-home'],'session-env/sessions');
  const old=path.join(dir,'old'), fresh=path.join(dir,'fresh');
  fs.mkdirSync(old,{recursive:true}); fs.mkdirSync(fresh); put(fresh,'activity','.',2);
  for(const d of [old,fresh]) fs.utimesSync(d,new Date(NOW-40*DAY),new Date(NOW-40*DAY));
  assert.equal(f.pass(['session-dirs']).stores[0].removed,1); assert.equal(fs.existsSync(fresh),true);
  const research=store(f,'research'), ns=path.join(research,'group');
  // AM22: a namespaced record finishes only through its feature's checked plan.
  put(path.join(f.project,'agent-docs/doflow/group'),'plan.md','- [x] done\n');
  put(ns,'idle.json','{}',31); put(ns,'idle.json.123.tmp','partial',2);
  fs.utimesSync(path.join(ns,'idle.json.123.tmp'),new Date(NOW-48*3600000),new Date(NOW-48*3600000));
  const outcome=f.pass(['task-research']).stores[0];
  assert.ok(outcome.removed>=2); assert.equal(fs.existsSync(ns),false);
});
test('registry order, result shape, and existing/control stores are not selected', t => {
  const f=fixture(t); const result=f.pass();
  assert.deepEqual(result.stores.map(s=>s.id), ['verification-runs','verification-v0','verification-reuse','task-delivery','worker-runs','worker-probes','worker-output','dispatch','roadmap','dispatch-envelopes','runs-telemetry','slots-user','summary-scopes','summary-grants','packages-plans','packages-staging','packages-fetched','packages-fetch-staging','verification-logs','task-evidence','task-readiness','task-research','task-outcome','task-retrieval','task-attempts','task-orchestration','runs-project','runs-user','advice-picks-project','advice-picks-user','lifecycle-events','report-bodies','session-dirs','project-dirs','recovery-user','recovery-project']);
  assert.equal(result.mode,'prune'); assert.equal(result.partial,false);
});

test('selection shares run and plan reads across record stores; each removal rechecks them fresh (G.1 R3)', t => {
  const f=fixture(t), now=NOW-31*DAY, runId='shared-run';
  const runFile=put(store(f,'orchestration'),`${runId}.json`,JSON.stringify({state:'COMPLETED',featureSlug:'feature-a',updatedAt:new Date(now).toISOString()}),31);
  const plan=path.join(f.project,'agent-docs/doflow/feature-a/plan.md');fs.mkdirSync(path.dirname(plan),{recursive:true});fs.writeFileSync(plan,'- [x] complete\n');
  put(store(f,'evidence'),`${runId}-evidence.json`,'{}',31);put(store(f,'readiness'),`${runId}-readiness.json`,'{}',31);
  const reads=new Map(), fsImpl=new Proxy(fs,{get(target,key){if(key==='readFileSync')return(file,...args)=>{const absolute=path.resolve(String(file));if(absolute===runFile||absolute===plan)reads.set(absolute,(reads.get(absolute)||0)+1);return target.readFileSync(file,...args);};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
  const result=f.pass(['task-evidence','task-readiness'],'prune',{fsImpl});
  const removed=result.stores.reduce((sum,row)=>sum+row.removed,0);
  assert.equal(removed,2);
  // One shared read during selection, plus one fresh read per removed record under its lock.
  assert.equal(reads.get(runFile),1+removed);assert.equal(reads.get(plan),1+removed);
});

test('work-state plan scanning observes the pass deadline before scanning every feature', t => {
  const f=fixture(t), planRoot=path.join(f.project,'agent-docs/doflow'), featureCount=30;
  for(let i=0;i<featureCount;i++){
    const dir=path.join(planRoot,`feature-${String(i).padStart(2,'0')}`);
    fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'plan.md'),'- [x] completed\\n');
  }
  const record=put(store(f,'research'),'idle.json','{}',31);let planReads=0;
  const fsImpl=new Proxy(fs,{get(target,key){
    if(key==='readFileSync')return(file,...args)=>{
      if(path.resolve(String(file)).startsWith(`${path.resolve(planRoot)}${path.sep}`)&&path.basename(String(file))==='plan.md'){
        planReads++;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
      }
      return target.readFileSync(file,...args);
    };
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
  const result=f.pass(['task-research'],'prune',{fsImpl,budgetMs:120});
  assert.equal(result.partial,true);assert.equal(result.stores[0].removed,0);assert.equal(fs.existsSync(record),true);
  assert.ok(planReads>0,`plan scan never started (${planReads}/${featureCount})`);
  assert.ok(planReads<featureCount,`workStatus read every feature plan (${planReads}/${featureCount})`);
});

test('an inaccessible open-work record fails open-log protection closed', t => {
  const f=fixture(t), dir=store(f,'verification/logs'), name=`${NOW-31*DAY}-protected-eacces.log`;
  const log=put(dir,name,'old'), evidence=put(store(f,'evidence'),'live-eacces.json',JSON.stringify({log:name}),120);
  put(store(f,'orchestration'),'live-eacces.json',JSON.stringify({state:'RUNNING'}),120);
  const fsImpl=new Proxy(fs,{get(target,key){
    if(key==='lstatSync')return(file,...args)=>{
      if(path.resolve(String(file))===path.resolve(evidence))throw Object.assign(new Error('injected record access failure'),{code:'EACCES'});
      return target.lstatSync(file,...args);
    };
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
  const result=f.pass(['verification-logs'],'prune',{fsImpl}).stores[0];
  assert.equal(result.removed,0);assert.deepEqual(result.failed,[{name:'verification-logs',code:'EIO'}]);assert.equal(fs.existsSync(log),true);
});

test('a safe namespace directory ending in .json is still visited', t => {
  const f=fixture(t), dir=path.join(store(f,'research'),'feature.json');put(dir,'idle.json','{}',31);
  put(path.join(f.project,'agent-docs/doflow/feature.json'),'plan.md','- [x] done\n');
  const result=f.pass(['task-research']).stores[0];
  assert.equal(result.removed,1);assert.equal(fs.existsSync(dir),false);
});

test('equal log timestamps use deterministic filename ordering', t => {
  const f=fixture(t), dir=store(f,'verification/logs');
  for(let i=0;i<41;i++)put(dir,`${NOW}-tie-${String(i).padStart(2,'0')}.log`,'x',0);
  const normal=f.pass(['verification-logs'],'report').stores[0].selected.map(e=>e.name);
  const fsImpl=new Proxy(fs,{get(target,key){if(key==='readdirSync')return(folder,...args)=>{const names=target.readdirSync(folder,...args);return path.resolve(folder)===path.resolve(dir)?names.reverse():names;};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
  const reversed=f.pass(['verification-logs'],'report',{fsImpl}).stores[0].selected.map(e=>e.name);
  assert.deepEqual(reversed,normal);
});

test('deadline exhaustion during inventory is partial and removes nothing', t => {
  const f=fixture(t), dir=store(f,'verification/logs');
  for(let i=0;i<10;i++)put(dir,`${NOW-i}-fresh-${i}.log`,'x',0);
  const fsImpl=new Proxy(fs,{get(target,key){if(key==='lstatSync')return(file,...args)=>{if(String(file).startsWith(`${dir}${path.sep}`))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);return target.lstatSync(file,...args);};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
  const result=f.pass(['verification-logs'],'prune',{fsImpl,budgetMs:5});
  assert.equal(result.partial,true);assert.equal(result.stores[0].removed,0);assert.equal(fs.readdirSync(dir).length,10);
});

test('deadline exhaustion during open-log protection is partial and deletes no logs', t => {
  const f=fixture(t), dir=store(f,'verification/logs');
  const name=`${NOW-31*DAY}-protected.log`, log=put(dir,name,'old');
  const evidence=put(store(f,'evidence'),'live.json',JSON.stringify({log:name}),120);
  put(store(f,'orchestration'),'live.json',JSON.stringify({state:'RUNNING'}),120);
  const fsImpl=new Proxy(fs,{get(target,key){if(key==='readFileSync')return(file,...args)=>{if(path.resolve(String(file))===path.resolve(evidence))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);return target.readFileSync(file,...args);};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
  const result=f.pass(['verification-logs'],'prune',{fsImpl,budgetMs:5});
  assert.equal(result.partial,true);assert.equal(result.stores[0].removed,0);assert.equal(fs.existsSync(log),true);
});

test('a linked work store makes open-log protection fail closed and says why (G.3 A6)', {skip:process.platform==='win32'}, t => {
  const f=fixture(t), dir=store(f,'verification/logs'), name=`${NOW-31*DAY}-protected-link.log`;
  const log=put(dir,name,'old'), state=f.roots['project-state'], outside=path.join(f.project,'outside-evidence');
  fs.mkdirSync(outside,{recursive:true});fs.writeFileSync(path.join(outside,'live.json'),JSON.stringify({log:name}));
  fs.mkdirSync(state,{recursive:true});fs.symlinkSync(outside,path.join(state,'evidence'));
  const result=f.pass(['verification-logs']).stores[0];
  assert.equal(result.removed,0);assert.deepEqual(result.failed,[{name:'verification-logs',code:'link-in-record-store'}]);assert.equal(fs.existsSync(log),true);
});

test('a symlinked work record makes open-log protection fail closed and says why (G.3 A6)', {skip:process.platform==='win32'}, t => {
  const f=fixture(t), dir=store(f,'verification/logs'), name=`${NOW-31*DAY}-protected-record-link.log`;
  const log=put(dir,name,'old'), evidence=store(f,'evidence'), outside=path.join(f.project,'outside-record.json');
  fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(outside,JSON.stringify({log:name}));fs.symlinkSync(outside,path.join(evidence,'live.json'));
  const result=f.pass(['verification-logs']).stores[0];
  assert.equal(result.removed,0);assert.deepEqual(result.failed,[{name:'verification-logs',code:'link-in-record-store'}]);assert.equal(fs.existsSync(log),true);
});

test('removal-time EIO is a failure, not a successful removal', t => {
  const f=fixture(t), file=put(store(f,'research'),'broken.json','{}',31);let calls=0;
  const fsImpl=new Proxy(fs,{get(target,key){if(key==='lstatSync')return(candidate,...args)=>{if(path.resolve(String(candidate))===path.resolve(file)&&++calls===3)throw Object.assign(new Error('injected lstat failure'),{code:'EIO'});return target.lstatSync(candidate,...args);};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
  const result=f.pass(['task-research'],'prune',{fsImpl}).stores[0];
  assert.equal(result.removed,0);assert.deepEqual(result.failed,[{name:'broken.json',code:'EIO'}]);assert.equal(fs.existsSync(file),true);
});
test('a prune pass removes a crashed lifecycle temp file older than staleTmpHours and keeps a younger one (FU-8g2g9z)', t => {
  const f = fixture(t), lifecycle = store(f, 'lifecycle'), events = path.join(lifecycle, 'events');
  const stamp = new Date(NOW - 200 * 3600000).toISOString().replace(/[-:.]/g, '');
  fs.mkdirSync(events, { recursive: true });
  const added = { v: 1, id: `${stamp}-000001`, type: 'followup.added', at: new Date(NOW - 200 * 3600000).toISOString(), by: 'agent', data: { id: 'FU-aaaaaa', statement: 's', source: { kind: 'manual' } } };
  const settled = { v: 1, id: `${stamp.replace('000Z', '001Z')}-000002`, type: 'followup.settled', at: new Date(NOW - 200 * 3600000 + 1).toISOString(), by: 'agent', data: { id: 'FU-aaaaaa', as: 'dismissed', reason: 'r' } };
  for (const event of [added, settled]) fs.writeFileSync(path.join(events, `${event.id}.json`), JSON.stringify(event));
  const stale = put(lifecycle, '.retention-4242-abc123.tmp', '{}', 2);
  const young = put(lifecycle, '.retention-4243-def456.tmp', '{}', 0);
  const result = f.pass(['lifecycle-events'], 'prune', { env: { DOFLOW_RETENTION_HOURS: '1' } }).stores[0];
  assert.equal(result.removed, 2, JSON.stringify(result));
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(young), true);
});
