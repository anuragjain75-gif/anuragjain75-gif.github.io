'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {GitHubProvider}=require('../../scripts/publishing/github-provider.cjs');

const make=(transport)=>new GitHubProvider({owner:'synthetic',repo:'desk',branch:'main',transport,credential:()=> 'TOKEN_MUST_NOT_APPEAR'});

test('transient GET failure is retried and then succeeds',async()=>{
  let calls=0;
  const transport=async()=>{calls++;if(calls===1){const e=Error('dns detail');e.code='ENOTFOUND';throw e;}return {status:200,body:{ok:true}};};
  assert.deepEqual(await make(transport).request('GET','/user'),{ok:true});
  assert.equal(calls,2);
});

test('exhausted GET retries report safe diagnostic context',async()=>{
  let calls=0;
  const transport=async()=>{calls++;const e=Error('secret.example.invalid');e.name='FetchError';e.code='EAI_AGAIN';throw e;};
  await assert.rejects(make(transport).request('GET','/repos/synthetic/desk'),error=>{
    assert.match(error.message,/GET \/repos\/synthetic\/desk/);
    assert.match(error.message,/name=FetchError/);
    assert.match(error.message,/code=EAI_AGAIN/);
    assert.match(error.message,/retries=2/);
    assert.doesNotMatch(error.message,/TOKEN_MUST_NOT_APPEAR|secret\.example/);
    return true;
  });
  assert.equal(calls,3);
});

test('write request is attempted once and never retried',async()=>{
  let calls=0;
  const transport=Object.assign(async()=>{calls++;const e=Error('connection reset');e.code='ECONNRESET';throw e;},{offlineMock:true});
  await assert.rejects(make(transport).request('POST','/graphql',{}),error=>{
    assert.match(error.message,/POST \/graphql/);
    assert.match(error.message,/code=ECONNRESET/);
    assert.match(error.message,/retries=0/);
    return true;
  });
  assert.equal(calls,1);
});
