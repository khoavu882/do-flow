'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {tempDir}=require('../helper/tmp');
const {projectKey}=require('../../src/runtime/lifecycle/report-store');
const registry=require('../../core/registry/storage.json');
const {runPass}=require('../../src/runtime/storage/engine');
const {retainLocked}=require('../../src/runtime/lifecycle/store-upkeep');
const NOW=Date.parse('2026-10-10T12:00:00Z'), DAY=86400000;
function fixture(t){const root=tempDir(t,'doflow-report-bodies-'), reports=path.join(root,'xdg/doflow/reports'), key=projectKey(root);fs.mkdirSync(reports,{recursive:true});return {root,reports,key,pass:(stores=['report-bodies'],mode='prune',extra={})=>runPass({registry,roots:{'project-state':path.join(root,'.doflow/state'),'config-home':path.dirname(reports)},stores,mode,setting:{'project-state':'on','config-home':'on'},now:NOW,...extra})};}
function body(dir,id,age=3){fs.mkdirSync(dir,{recursive:true});const p=path.join(dir,`${id}.txt`);fs.writeFileSync(p,'body');fs.utimesSync(p,new Date(NOW-age*DAY),new Date(NOW-age*DAY));return p;}
function event(f,id,type){const dir=path.join(f.root,'.doflow/state/lifecycle/events');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,`20260101T000000000Z-${String(fs.readdirSync(dir).length).padStart(6,'0')}.json`),JSON.stringify({v:1,id:`20260101T000000000Z-${String(fs.readdirSync(dir).length).padStart(6,'0')}`,at:'2026-01-01T00:00:00.000Z',type,by:'user',data:{id}}));}
function settledEvents(f,id){const dir=path.join(f.root,'.doflow/state/lifecycle/events');fs.mkdirSync(dir,{recursive:true});for(const [suffix,type,data] of [['000000','followup.added',{id,statement:'old item',source:{kind:'manual'}}],['000001','followup.settled',{id,as:'dismissed',reason:'closed'}]]){const eventId=`20260101T000000000Z-${suffix}`;fs.writeFileSync(path.join(dir,`${eventId}.json`),JSON.stringify({v:1,id:eventId,at:'2026-01-01T00:00:00.000Z',type,by:'agent',data}));}return dir;}
test('unmarked or unreadable lifecycle store keeps orphan bodies; marked readable removes orphan and empty key',t=>{
  const f=fixture(t), dir=path.join(f.reports,f.key), orphan=body(dir,'FU-123456');
  assert.equal(f.pass().stores[0].removed,0);
  const lifecycle=path.join(f.root,'.doflow/state/lifecycle');fs.mkdirSync(lifecycle,{recursive:true});
  fs.writeFileSync(path.join(lifecycle,'migrated.json'),'{}');
  fs.mkdirSync(path.join(lifecycle,'events'),{recursive:true});
  // A directory where an event file should be makes the event set unreadable and fails closed.
  fs.mkdirSync(path.join(lifecycle,'events/20260101T000000000Z-123456.json'));
  assert.equal(f.pass().stores[0].removed,0);
  fs.rmdirSync(path.join(lifecycle,'events/20260101T000000000Z-123456.json'));
  assert.equal(f.pass().stores[0].removed,1);assert.equal(fs.existsSync(orphan),false);
  assert.equal(fs.existsSync(dir),false);
});
test('open and taken follow-ups keep bodies; unrelated orphan is removed',t=>{
  const f=fixture(t), dir=path.join(f.reports,f.key), lifecycle=path.join(f.root,'.doflow/state/lifecycle');
  const open=body(dir,'FU-123456'), taken=body(dir,'FU-234567'), orphan=body(dir,'FU-345678');
  fs.mkdirSync(lifecycle,{recursive:true});fs.writeFileSync(path.join(lifecycle,'migrated.json'),'{}');
  event(f,'FU-123456','followup.added');event(f,'FU-234567','followup.added');event(f,'FU-234567','followup.taken');
  const result=f.pass().stores[0];assert.equal(result.removed,1);assert.equal(fs.existsSync(open),true);assert.equal(fs.existsSync(taken),true);assert.equal(fs.existsSync(orphan),false);
});
test('foreign missing-root folder expires by newest body; missing .root is kept',t=>{
  const f=fixture(t), expired=path.join(f.reports,'abcdefabcdef'), unknown=path.join(f.reports,'deadbeefdead'), recent=path.join(f.reports,'123456789abc');
  const unrelated=path.join(f.reports,'abcdef123456');
  body(expired,'FU-123456',181);body(unknown,'FU-123456',181);body(recent,'FU-123456',2);body(unrelated,'FU-123456',181);
  for(const d of [expired,recent,unrelated]) fs.writeFileSync(path.join(d,'.root'),path.join(f.root,'missing')+'\n');
  fs.writeFileSync(path.join(unrelated,'user-note'),'do not delete');
  const result=f.pass().stores[0];assert.equal(result.removed,1);assert.equal(fs.existsSync(expired),false);assert.equal(fs.existsSync(unknown),true);assert.equal(fs.existsSync(recent),true);
  assert.equal(fs.readFileSync(path.join(unrelated,'user-note'),'utf8'),'do not delete');
});
test('lifecycle-settled reports eligible event files and removes through locked retention',t=>{
  const f=fixture(t), dir=path.join(f.root,'.doflow/state/lifecycle/events');fs.mkdirSync(dir,{recursive:true});
  const at=new Date(NOW-181*DAY).toISOString();
  for(const [index,type,data] of [[0,'followup.added',{id:'FU-123456',statement:'old',source:{kind:'manual'}}],[1,'followup.settled',{id:'FU-123456',as:'dismissed',reason:'closed'}]]) {
    const id=`${at.replace(/[-:.]/g,'')}-${String(index).padStart(6,'0')}`;
    fs.writeFileSync(path.join(dir,`${id}.json`),JSON.stringify({v:1,id,at,type,by:'agent',data}));
  }
  const options={registry,roots:{'project-state':path.join(f.root,'.doflow/state')},stores:['lifecycle-events'],mode:'report',setting:{'project-state':'on'},now:NOW};
  const report=runPass(options).stores[0];assert.equal(report.selected.length,2);assert.equal(fs.readdirSync(dir).length,2);
  const result=f.pass(['lifecycle-events']).stores[0];assert.equal(result.removed,2);assert.equal(fs.readdirSync(dir).length,0);
});

test('malformed lifecycle envelopes make orphan detection fail closed',t=>{
  const f=fixture(t),dir=path.join(f.reports,f.key),orphan=body(dir,'FU-456789',3),lifecycle=path.join(f.root,'.doflow/state/lifecycle'),events=path.join(lifecycle,'events');
  fs.mkdirSync(events,{recursive:true});fs.writeFileSync(path.join(lifecycle,'migrated.json'),'{}');
  const id='20260101T000000000Z-123456';fs.writeFileSync(path.join(events,`${id}.json`),JSON.stringify({v:1,id,type:'unknown.event',data:{}}));
  assert.equal(f.pass().stores[0].removed,0);assert.equal(fs.existsSync(orphan),true);
});

test('orphan detection does not follow a linked lifecycle parent', {skip:process.platform==='win32'}, t=>{
  const f=fixture(t),dir=path.join(f.reports,f.key),orphan=body(dir,'FU-567890',3),state=path.join(f.root,'.doflow/state'),outside=path.join(f.root,'outside-lifecycle');
  fs.mkdirSync(state,{recursive:true});fs.mkdirSync(path.join(outside,'events'),{recursive:true});fs.writeFileSync(path.join(outside,'migrated.json'),'{}');fs.writeFileSync(path.join(outside,'keep'),'safe');
  fs.symlinkSync(outside,path.join(state,'lifecycle'));
  assert.equal(f.pass().stores[0].removed,0);assert.equal(fs.existsSync(orphan),true);assert.equal(fs.readFileSync(path.join(outside,'keep'),'utf8'),'safe');
});

test('an inaccessible foreign root is not treated as absent',t=>{
  const f=fixture(t),foreign=path.join(f.reports,'abcdefabcdef'),target=path.join(f.root,'inaccessible-project');body(foreign,'FU-678901',181);fs.mkdirSync(target);fs.writeFileSync(path.join(foreign,'.root'),`${target}\n`);
  const fsImpl=new Proxy(fs,{get(object,key){if(key==='existsSync')return(candidate)=>path.resolve(String(candidate))===path.resolve(target)?false:object.existsSync(candidate);if(key==='lstatSync')return(candidate,...args)=>{if(path.resolve(String(candidate))===path.resolve(target))throw Object.assign(new Error('permission denied'),{code:'EACCES'});return object.lstatSync(candidate,...args);};const value=object[key];return typeof value==='function'?value.bind(object):value;}});
  assert.equal(f.pass(['report-bodies'],'prune',{fsImpl}).stores[0].removed,0);assert.equal(fs.existsSync(foreign),true);
});

test('lifecycle retention defers a settled unit that cannot fit the remaining removal cap',t=>{
  const f=fixture(t),events=settledEvents(f,'FU-789012');
  const first=f.pass(['lifecycle-events'],'prune',{maxRemovals:1}).stores[0];
  assert.equal(first.removed,0);assert.equal(first.selected.length,0);assert.equal(fs.readdirSync(events).length,2);
  const expected=fs.readdirSync(events).map(name=>({name,bytes:fs.statSync(path.join(events,name)).size})).sort((a,b)=>a.name.localeCompare(b.name));
  const second=f.pass(['lifecycle-events'],'prune',{maxRemovals:2}).stores[0];
  assert.equal(second.removed,2);assert.deepEqual(second.selected.map(({name,bytes})=>({name,bytes})).sort((a,b)=>a.name.localeCompare(b.name)),expected);assert.equal(fs.readdirSync(events).length,0);
});

test('lifecycle retention treats a held store lock as partial without waiting',t=>{
  const f=fixture(t),events=settledEvents(f,'FU-890123');fs.mkdirSync(`${events}.lock`);
  const started=Date.now(),result=f.pass(['lifecycle-events'],'prune'),elapsed=Date.now()-started;
  assert.equal(result.partial,true);assert.equal(result.stores[0].removed,0);assert.equal(elapsed<100,true,`held-lock pass waited ${elapsed} ms`);assert.equal(fs.readdirSync(events).length,2);
});

test('a partially consumed journal resumes under a smaller cap without charging absent names',t=>{
  const f=fixture(t),lifecycle=path.join(f.root,'.doflow/state/lifecycle'),events=path.join(lifecycle,'events');
  fs.mkdirSync(events,{recursive:true});
  const names=['20260101T000000000Z-000001.json','20260101T000000000Z-000002.json'];
  names.forEach(name=>fs.writeFileSync(path.join(events,name),'{}'));
  const journal=path.join(lifecycle,'retention.json');
  fs.writeFileSync(journal,`${JSON.stringify({v:1,generation:'first-generation',pending:names})}\n`);
  const firstFile=path.join(events,names[0]);let firstUnlinked=false;
  const fsImpl=new Proxy(fs,{get(target,key){
    if(key==='unlinkSync')return(file,...args)=>{
      const result=target.unlinkSync(file,...args);
      if(path.resolve(String(file))===path.resolve(firstFile))firstUnlinked=true;
      return result;
    };
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
  const first=retainLocked(f.root,{window:{state:'off'},now:new Date(NOW),fsImpl,maxFiles:2,shouldStop:()=>firstUnlinked});
  assert.equal(first.partial,true);assert.equal(first.removed,1);assert.equal(fs.existsSync(firstFile),false);assert.equal(fs.existsSync(path.join(events,names[1])),true);
  const resumed=retainLocked(f.root,{window:{state:'off'},now:new Date(NOW),fsImpl,maxFiles:1,shouldStop:()=>false});
  assert.equal(resumed.partial,false);assert.equal(resumed.removed,1);assert.equal(fs.existsSync(path.join(events,names[1])),false);
  assert.deepEqual(JSON.parse(fs.readFileSync(journal,'utf8')).pending,[]);
});

test('report-mode lifecycle reads never acquire a lock after journal churn',t=>{
  const f=fixture(t),lifecycle=path.join(f.root,'.doflow/state/lifecycle'),events=path.join(lifecycle,'events'),journal=path.join(lifecycle,'retention.json'),lock=`${events}.lock`;
  fs.mkdirSync(events,{recursive:true});fs.writeFileSync(journal,'{"v":1,"generation":"aaaaaaaaaaaaaaaa","pending":[]}\n');
  const descriptors=new Map(),readCounts=new Map();let generation=0,lockAttempts=0;
  const fsImpl=new Proxy(fs,{get(object,key){
    if(key==='openSync')return(file,...args)=>{const fd=object.openSync(file,...args);descriptors.set(fd,path.resolve(String(file)));return fd;};
    if(key==='readSync')return(fd,buffer,offset,length,position)=>{if(descriptors.get(fd)!==path.resolve(journal))return object.readSync(fd,buffer,offset,length,position);const count=readCounts.get(fd)||0;readCounts.set(fd,count+1);if(count>0)return 0;const text=`{"v":1,"generation":"g${String(++generation).padStart(15,'0')}","pending":[]}\n`,bytes=Buffer.from(text);bytes.copy(buffer,offset,0,Math.min(length,bytes.length));return Math.min(length,bytes.length);};
    if(key==='closeSync')return(fd,...args)=>{descriptors.delete(fd);readCounts.delete(fd);return object.closeSync(fd,...args);};
    if(key==='mkdirSync')return(dir,...args)=>{if(path.resolve(String(dir))===path.resolve(lock))lockAttempts++;return object.mkdirSync(dir,...args);};
    const value=object[key];return typeof value==='function'?value.bind(object):value;
  }});
  f.pass(['lifecycle-events'],'report',{fsImpl});
  assert.equal(lockAttempts,0);assert.equal(fs.existsSync(lock),false);
});

test('lifecycle-settled reads DOFLOW_RETENTION_HOURS from the env the caller passes (G.3 A7)',t=>{
  const f=fixture(t), dir=path.join(f.root,'.doflow/state/lifecycle/events');fs.mkdirSync(dir,{recursive:true});
  const at=new Date(NOW-2*DAY).toISOString();
  for(const [index,type,data] of [[0,'followup.added',{id:'FU-123456',statement:'old',source:{kind:'manual'}}],[1,'followup.settled',{id:'FU-123456',as:'dismissed',reason:'closed'}]]) {
    const id=`${at.replace(/[-:.]/g,'')}-${String(index).padStart(6,'0')}`;
    fs.writeFileSync(path.join(dir,`${id}.json`),JSON.stringify({v:1,id,at,type,by:'agent',data}));
  }
  const saved=process.env.DOFLOW_RETENTION_HOURS;delete process.env.DOFLOW_RETENTION_HOURS;
  try {
    const options={registry,roots:{'project-state':path.join(f.root,'.doflow/state')},stores:['lifecycle-events'],mode:'report',setting:{'project-state':'on'},now:NOW};
    assert.equal(runPass(options).stores[0].selected.length,0,'the 4320 h default keeps two-day-old events');
    assert.equal(runPass({...options,env:{DOFLOW_RETENTION_HOURS:'1'}}).stores[0].selected.length,2);
  } finally { if(saved===undefined)delete process.env.DOFLOW_RETENTION_HOURS;else process.env.DOFLOW_RETENTION_HOURS=saved; }
});
