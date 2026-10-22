'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MODEL_VERSION, model, check } = require('../helper/ledger-oracle.js');

const active = () => ({ token: 1, state: 'active', result: null });
const ack = (response) => ({ kind: 'DONE', response });
const actor = (name, op, outcome, args = { task: 'A.1', token: 1, result: 'BLOCKED' }) => ({ name, op, args, outcome });
const obs = (scenario, init, actors, final, extra = {}) => ({ scenario, init, fault: null, actors, final, incomplete: null, ...extra });

const cases = [
  ['unclaimed', () => model.initial('S2'), { claim: [['claimed', null, 1], 'active'], finish: [['stale', 'no-active-attempt'], null], cancel: [['refused', 'no-active-attempt'], null] }],
  ['active', () => model.initial('S1'), { claim: [['refused', 'active-attempt'], 'active'], finish: [['applied', null], 'finished'], cancel: [['cancelled', null], 'cancelled'] }],
  ['finished', () => ({ nextToken: 2, attempts: [{ token: 1, state: 'finished', result: 'BLOCKED' }] }), { claim: [['claimed', null, 2], 'active'], finish: [['stale', 'no-active-attempt'], 'finished'], cancel: [['refused', 'no-active-attempt'], 'finished'] }],
  ['cancelled', () => ({ nextToken: 2, attempts: [{ token: 1, state: 'cancelled', result: null, cancel: {} }] }), { claim: [['refused', 'cancelled'], 'cancelled'], finish: [['stale', 'attempt-cancelled'], 'cancelled'], cancel: [['refused', 'no-active-attempt'], 'cancelled'] }],
];
test('model table documents each operation and state transition', () => {
  assert.equal(MODEL_VERSION, '117-B.2');
  for (const [label, make, expected] of cases) {
    for (const op of ['claim', 'finish', 'cancel']) {
      // Source behavior: task-attempts.ts claimChecks :307-353 and claimWrite :355-382;
      // finish :459-497; cancel :623-640; task-run.ts cancelAttempt :335-356, refusedControl :250-252.
      const args = op === 'claim' ? { task: 'A.1', owner: 'worker', mode: 'subagent' } : { task: 'A.1', token: 1, result: 'BLOCKED', by: 'lead', reason: 'stop' };
      const out = model.apply(make(), op, args);
      assert.equal(out.response.disposition, expected[op][0][0], `${label}/${op}`);
      if (expected[op][0][1]) assert.equal(out.response.reason, expected[op][0][1], `${label}/${op}`);
      if (expected[op][0][2]) assert.equal(out.response.token, expected[op][0][2], `${label}/${op}`);
      assert.equal(out.state.attempts.at(-1)?.state ?? null, expected[op][1], `${label}/${op} state`);
    }
  }
});

test('lost acknowledgment and suspected model defect', () => {
  const h = obs('S1', 'stale', [actor('A','finish',ack({ disposition:'applied', taskId:'A.1', token:1, result:'BLOCKED' })), actor('B','cancel',ack({ disposition:'cancelled', taskId:'A.1', token:1 }))], { nextToken:2, attempts:[{ token:1, state:'cancelled', result:null, cancel:{} }] });
  assert.deepEqual([check(h).verdict, check(h).class], ['VIOLATION','lost-ack']);
  const defect = check({ ...h, init:'none', fault:null });
  assert.deepEqual([defect.class, defect.underlying], ['suspected-model-defect','lost-ack']);
});
test('resurrected acknowledgment history', () => {
  const h = obs('S1','stale',[actor('A','finish',ack({ disposition:'applied',taskId:'A.1',token:1,result:'BLOCKED' })),actor('B','cancel',ack({ disposition:'cancelled',taskId:'A.1',token:1 }))],{nextToken:2,attempts:[{token:1,state:'finished',result:'BLOCKED'}]});
  assert.deepEqual([check(h).verdict,check(h).class],['VIOLATION','resurrected']);
});
test('double grant and final-record-only negative control', () => {
  const h=obs('S2','stale',[actor('A','claim',ack({disposition:'claimed',taskId:'A.1',token:1})),actor('B','claim',ack({disposition:'claimed',taskId:'A.1',token:1}))],{nextToken:2,attempts:[active()]});
  function finalOnly(observation) { const s=model.apply(model.initial('S2'),'claim',{task:'A.1'}).state; return JSON.stringify(s.attempts.map(a=>[a.token,a.state,a.result,a.cancel!==undefined]))===JSON.stringify(observation.final.attempts.map(a=>[a.token,a.state,a.result,a.cancel!==undefined])) && s.nextToken===observation.final.nextToken ? 'PASS' : 'VIOLATION'; }
  assert.equal(finalOnly(h),'PASS');
  assert.deepEqual([check(h).verdict,check(h).class],['VIOLATION','double-grant']);
});
test('final-record-blind oracle negative control', () => {
  const h=obs('S1','stale',[
    actor('A','finish',ack({disposition:'applied',taskId:'A.1',token:1,result:'BLOCKED'})),
    actor('B','cancel',ack({disposition:'refused',reason:'no-active-attempt',runKey:'r',taskId:'A.1',token:1})),
  ],{nextToken:2,attempts:[active()]});
  function blindCheck(observation) {
    const orders=[[0,1],[1,0]];
    for (const order of orders) {
      for (const include0 of [true]) for (const include1 of [true]) {
        let state=model.initial(observation.scenario); let valid=true;
        for (const i of order) {
          const a=observation.actors[i];
          const out=model.apply(state,a.op,a.args); state=out.state;
          const actual=a.outcome.response;
          if (!actual || typeof actual!=='object' || actual.disposition!==out.response.disposition ||
              (out.response.token !== undefined && actual.token!==out.response.token) ||
              (out.response.reason !== undefined && actual.reason!==out.response.reason) ||
              (out.response.result !== undefined && actual.result!==out.response.result) ||
              (out.response.activeToken !== undefined && actual.activeToken!==out.response.activeToken)) valid=false;
        }
        if (valid) return 'PASS'; // Deliberately ignores sameRecord.
      }
    }
    return 'VIOLATION';
  }
  assert.equal(blindCheck(h),'PASS');
  assert.equal(check(h).verdict,'VIOLATION');
});
test('empty claim responses never PASS', () => {
  const empty=obs('S2','stale',[
    actor('A','claim',ack({})),actor('B','claim',ack({})),
  ],{nextToken:2,attempts:[active()]});
  assert.notEqual(check(empty).verdict,'PASS');
});
test('claimed response without token never PASS', () => {
  const missingClaimToken=obs('S2','stale',[
    actor('A','claim',ack({disposition:'claimed'})),
    actor('B','claim',ack({disposition:'refused',reason:'active-attempt',activeToken:1})),
  ],{nextToken:2,attempts:[active()]});
  assert.notEqual(check(missingClaimToken).verdict,'PASS');
});
test('applied finish without result never PASS', () => {
  const missingResult=obs('S1','stale',[
    actor('A','finish',ack({disposition:'applied',token:1})),
    actor('B','cancel',ack({disposition:'refused',token:1,reason:'no-active-attempt'})),
  ],{nextToken:2,attempts:[{token:1,state:'finished',result:'BLOCKED'}]});
  assert.notEqual(check(missingResult).verdict,'PASS');
});
test('stale response without reason never PASS', () => {
  const missingReason=obs('S2','stale',[
    actor('A','finish',ack({disposition:'stale',token:1})),
    actor('B','cancel',ack({disposition:'refused',token:1,reason:'no-active-attempt'})),
  ],{nextToken:1,attempts:[]});
  assert.notEqual(check(missingReason).verdict,'PASS');
});
test('two acknowledged claims with different tokens are a double grant', () => {
  const h=obs('S2','stale',[actor('A','claim',ack({disposition:'claimed',taskId:'A.1',token:1})),actor('B','claim',ack({disposition:'claimed',taskId:'A.1',token:2}))],{nextToken:3,attempts:[{token:1,state:'cancelled',result:null,cancel:{}},active()].map((a,i)=>({...a,token:i+1}))});
  assert.deepEqual([check(h).verdict,check(h).class],['VIOLATION','double-grant']);
});
test('linearizable finish then refused cancel', () => {
  const h=obs('S1','stale',[actor('A','finish',ack({disposition:'applied',taskId:'A.1',token:1,result:'BLOCKED'})),actor('B','cancel',ack({disposition:'refused',taskId:'A.1',token:1,reason:'no-active-attempt'}))],{nextToken:2,attempts:[{token:1,state:'finished',result:'BLOCKED'}]});
  assert.deepEqual([check(h).verdict,check(h).order],['PASS',['A','B']]);
});
test('linearizable claim then refused claim', () => {
  const cargs={task:'A.1',owner:'worker',mode:'subagent'};
  const h=obs('S2','stale',[actor('A','claim',ack({disposition:'claimed',taskId:'A.1',token:1}),cargs),actor('B','claim',ack({disposition:'refused',taskId:'A.1',reason:'active-attempt',activeToken:1}),cargs)],{nextToken:2,attempts:[active()]});
  assert.deepEqual([check(h).verdict,check(h).order],['PASS',['A','B']]);
});
test('non-store THREW operation can be unapplied', () => {
  const h=obs('S1','stale',[actor('A','finish',{kind:'THREW',code:null,message:'unexpected'}),actor('B','cancel',ack({disposition:'cancelled',taskId:'A.1',token:1}))],{nextToken:2,attempts:[{token:1,state:'cancelled',result:null,cancel:{}}]});
  assert.equal(check(h).verdict,'PASS');
});
test('unmatched history is other-nonlinearizable', () => {
  const h=obs('S1','stale',[actor('A','finish',ack({disposition:'stale',taskId:'A.1',token:1,reason:'token-mismatch'})),actor('B','cancel',ack({disposition:'refused',taskId:'A.1',token:1,reason:'no-active-attempt'}))],{nextToken:2,attempts:[active()]});
  assert.deepEqual([check(h).verdict,check(h).class],['VIOLATION','other-nonlinearizable']);
});
test('incomplete observations and outcomes always map to INCOMPLETE', () => {
  for(const cause of ['child-crash','schedule-deadline','ungated-store-call','replay-divergence','fault-not-applied','store-unreadable','no-store-call']) assert.equal(check(obs('S1','stale',[],null,{incomplete:{cause,detail:'x'}})).verdict,'INCOMPLETE');
  assert.equal(check(obs('S1','stale',[
    actor('A','finish',{kind:'THREW',code:'store-unreadable',message:'x'}),
    actor('B','cancel',ack({disposition:'cancelled',token:1})),
  ],null)).cause,'store-unreadable');
  assert.equal(check(obs('S1','stale',[actor('A','finish',{kind:'NONE'})],null)).cause,'child-crash');
});
test('all actors throwing is incomplete while one throw remains maybe unapplied', () => {
  const h=obs('S1','stale',[
    actor('A','finish',{kind:'THREW',code:'plan-unreadable',message:'x'}),
    actor('B','cancel',{kind:'THREW',code:'plan-unreadable',message:'x'}),
  ],{nextToken:2,attempts:[active()]});
  assert.deepEqual([check(h).verdict,check(h).cause],['INCOMPLETE','actor-threw']);
});
