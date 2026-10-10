'use strict';
const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {tempDir}=require('../helper/tmp');
const registry=require('../../core/registry/storage.json');
const {runPass}=require('../../src/runtime/storage/engine');
const NOW=Date.parse('2026-10-10T12:00:00Z');
function pass(root, stores=['verification-logs']) { return runPass({registry,roots:{'project-state':path.join(root,'.doflow/state')},stores,mode:'prune',setting:{'project-state':'on'},now:NOW}); }
test('nonmatching names, wrong types, the store directory, and agent-docs remain untouched',t=>{
  const root=tempDir(t,'doflow-containment-'), dir=path.join(root,'.doflow/state/verification/logs');
  fs.mkdirSync(path.join(dir,'1000000000000-dir.log'),{recursive:true});
  fs.writeFileSync(path.join(dir,'1000000000000-other.txt'),'safe');
  fs.writeFileSync(path.join(dir,'1000000000000-valid.log'),'old');
  const plan=path.join(root,'agent-docs/doflow/project/plan.md');fs.mkdirSync(path.dirname(plan),{recursive:true});fs.writeFileSync(plan,'safe');
  const r=pass(root).stores[0];assert.equal(r.removed,1);
  assert.equal(fs.existsSync(dir),true);assert.equal(fs.existsSync(path.join(dir,'1000000000000-dir.log')),true);
  assert.equal(fs.readFileSync(plan,'utf8'),'safe');assert.equal(fs.readFileSync(path.join(dir,'1000000000000-other.txt'),'utf8'),'safe');
});
test('outside file and directory symlinks are never followed or removed',{skip:process.platform==='win32'},t=>{
  const root=tempDir(t,'doflow-containment-link-'), dir=path.join(root,'.doflow/state/verification/logs');fs.mkdirSync(dir,{recursive:true});
  const outside=path.join(root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'keep'),'safe');
  fs.symlinkSync(path.join(outside,'keep'),path.join(dir,'1000000000000-file.log'));
  fs.symlinkSync(outside,path.join(dir,'1000000000001-dir.log'));
  assert.equal(pass(root).stores[0].removed,0);
  assert.equal(fs.readFileSync(path.join(outside,'keep'),'utf8'),'safe');assert.equal(fs.readdirSync(dir).length,2);
});
test('link in a DoFlow-owned component skips store',{skip:process.platform==='win32'},t=>{
  const root=tempDir(t,'doflow-containment-component-'), outside=path.join(root,'outside');fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside,'1000000000000-case.log'),'safe');
  fs.mkdirSync(path.join(root,'.doflow/state/verification'),{recursive:true});fs.symlinkSync(outside,path.join(root,'.doflow/state/verification/logs'));
  assert.equal(pass(root).stores[0].skipped,'link');assert.equal(fs.readFileSync(path.join(outside,'1000000000000-case.log'),'utf8'),'safe');
});
