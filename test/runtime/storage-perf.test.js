'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {tempDir}=require('../helper/tmp');
const registry=require('../../core/registry/storage.json');
const {runPass}=require('../../src/runtime/storage/engine');
const NOW=Date.parse('2026-10-10T12:00:00Z');
function backlog(t,count){
  const root=tempDir(t,'doflow-storage-perf-'), dir=path.join(root,'.doflow/state/verification/logs');fs.mkdirSync(dir,{recursive:true});
  for(let i=0;i<count;i++)fs.writeFileSync(path.join(dir,`${String(1000000000000+i)}-perf.log`),'x');
  return {dir,options:{registry,roots:{'project-state':path.join(root,'.doflow/state')},stores:['verification-logs'],mode:'prune',setting:{'project-state':'on'},now:NOW}};
}
/** Passes until one completes; every pass must make progress and stay within the removal cap. */
function drain(dir,options,limit=50){
  const passes=[];
  for(let i=0;i<limit;i++){
    const result=runPass(options), removed=result.stores[0].removed;
    passes.push({partial:result.partial,removed,onDisk:fs.readdirSync(dir).length});
    assert.ok(removed<=registry.settings.maxRemovalsPerPass,`pass ${i} removed ${removed}`);
    if(!result.partial)return passes;
    assert.ok(removed>0,`partial pass ${i} made no progress`);
  }
  assert.fail(`backlog not finished in ${limit} passes: ${JSON.stringify(passes)}`);
}
test('10,000 expired logs respect the pass budget and later passes finish the backlog',t=>{
  const {dir,options}=backlog(t,10000);
  const start=performance.now(), first=runPass(options), elapsed=performance.now()-start;
  t.diagnostic(`storage pass 10,000 logs: ${elapsed.toFixed(1)} ms, removed ${first.stores[0].removed}`);
  assert.ok(elapsed<=registry.settings.passBudgetMs+250,`pass took ${elapsed} ms`);
  assert.ok(first.partial || first.stores[0].removed===10000);
  assert.equal(first.stores[0].removed+fs.readdirSync(dir).length,10000,'removed counts what left the disk');
  const rest=drain(dir,options);
  assert.equal(first.stores[0].removed+rest.reduce((sum,pass)=>sum+pass.removed,0),10000);
  assert.equal(fs.readdirSync(dir).length,0);
});
// G.4: under load the first pass can stop on the time budget before the 5,000 cap; the next pass
// then stops on the cap, so two passes leave a remainder. Accounting is exact; a third pass finishes.
test('a budget-cut pass followed by cap-bounded passes removes the whole backlog with exact counts (G.4)',t=>{
  const {dir,options}=backlog(t,10000);
  // A virtual clock: time stands still until the 4,885th unlink, so machine load cannot move the cut.
  let clock=0, unlinks=0;
  t.mock.method(performance,'now',()=>clock);
  const fsImpl=new Proxy(fs,{get(target,key){
    if(key==='unlinkSync')return(file)=>{target.unlinkSync(file);if(++unlinks===4885)clock+=1e9;};
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
  const first=runPass({...options,fsImpl});
  assert.deepEqual([first.partial,first.stores[0].removed,fs.readdirSync(dir).length],[true,4885,5115]);
  const rest=drain(dir,{...options,fsImpl});
  assert.deepEqual(rest,[{partial:true,removed:5000,onDisk:115},{partial:false,removed:115,onDisk:0}]);
  assert.equal(first.stores[0].removed+rest.reduce((sum,pass)=>sum+pass.removed,0),10000);
});
