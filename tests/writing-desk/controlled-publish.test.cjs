'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Readable} = require('node:stream');
const cp = require('node:child_process');
const base = '../../scripts/publishing/';
const {AttemptPermit} = require(base + 'attempt-permit.cjs');
const {privateCredential} = require(base + 'private-credential.cjs');
const {GitHubProvider, PRODUCTION_WRITES_ENABLED} = require(base + 'github-provider.cjs');

const actualExec = cp.execFileSync;
let probe;
try {
  cp.execFileSync = (file, args, options) => {
    probe = {file, args, env: options.env};
    return 'mock Hugo version';
  };
  require(base + 'engine/hugo-authority.cjs');
} finally { cp.execFileSync = actualExec; }

const foundation = require(base + 'engine/foundation-plan.cjs');
const {Journal} = require(base + 'engine/operation-journal.cjs');
const actualVerifyFoundation = foundation.verifyFoundation;
let verifiedFoundation;
foundation.verifyFoundation = (...args) => { verifiedFoundation = args; };
const runner = require(base + 'provider-runner.cjs');
foundation.verifyFoundation = actualVerifyFoundation;

const target = {owner: 'synthetic', repo: 'desk', branch: 'main'};
const expectedIdentity = {userId: 123, login: 'fixture', repositoryId: 'fixture-repo'};
const parent = 'a'.repeat(40);
const head = 'b'.repeat(40);
const tree = 'c'.repeat(40);
const entry = 'content/works/fixture/index.md';
const operationId = 'd'.repeat(64);
const sourceHash = 'e'.repeat(64);
const fakeToken = 'SYNTHETIC_TOKEN_76';

function fixture(t) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-permit-fixture-'));
  t.after(() => fs.rmSync(state, {recursive: true, force: true}));
  const root = path.join(state, 'journals');
  fs.mkdirSync(root, {mode: 0o700});
  const permits = new AttemptPermit(state);
  const tx = {operationId, target, parent, commit: head, tree, digest: 'f'.repeat(64)};
  const plan = {request: {documentRequest: {selected: entry, expectedSourceHash: sourceHash}}, payload: []};
  const descriptor = {directSource: {revision: 'LOCAL:' + sourceHash, assets: {}}, plan, localRoot: state, snapshot: state};
  const snapshot = path.join(state, 'snapshot');
  fs.mkdirSync(snapshot);
  descriptor.snapshot = snapshot;
  const journal = new Journal(root);
  journal.create(tx, descriptor);
  function engine() {
    const store = new Journal(root);
    return {journal: store, load(id) {
      const {prepared, records} = store.read(id);
      const previous = records.at(-1).type;
      const submission = {PREPARED:'not-submitted', ATTEMPT_STARTED:'unknown', UNKNOWN:'unknown',
        ACCEPTED:'accepted', REJECTED:'rejected'}[previous];
      return {...prepared, current: {submission}};
    }};
  }
  const live = {attempts: 0, head: parent, beforeWrite: null, lostAck: false, identityChecks: 0};
  const provider = {
    writesEnabled: true,
    async verifyIdentity() { live.identityChecks++; },
    async snapshot(expected) {
      if (live.head !== expected) throw Error('Remote parent changed');
      return {head: live.head};
    },
    async head() {return live.head;},
    async contains(current, wanted) {return current === wanted ? {tree: {sha: tree}} : null;},
    async publish() {
      live.attempts++;
      live.beforeWrite?.();
      live.head = head;
      if (live.lostAck) throw Error('Synthetic lost acknowledgement');
    },
  };
  return {state, root, engine, permits, provider, live,
    op: () => engine().load(operationId),
    submit: (direct = true, validate = () => {}, store = permits) =>
      runner.submit(engine(), operationId, provider, validate, {direct, permits: store})};
}

test('exact direct permit is consumed and journaled before the sole provider handoff', async t => {
  const f = fixture(t);
  const grant = f.permits.issue(f.op());
  assert.equal(grant.binding.operationId, operationId);
  f.live.beforeWrite = () => {
    assert.throws(() => f.permits.check(f.op()), /spent/);
    assert.equal(f.engine().journal.read(operationId).records.at(-1).data.permitId, grant.id);
    assert.ok(verifiedFoundation);
  };
  assert.equal((await f.submit()).submission, 'accepted');
  assert.equal((await f.submit()).submission, 'accepted');
  assert.equal(f.live.attempts, 1);
  assert.throws(() => f.permits.check(f.op()), /spent/);
});

test('delayed pre-submission validation still spends only after validation and before the write', async t => {
  const f = fixture(t);
  f.permits.issue(f.op());
  let started = false;
  f.live.beforeWrite = () => { started = true; };
  const result = await f.submit(true, async () => {
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(f.live.attempts, 0);
    assert.equal(f.engine().journal.read(operationId).records.at(-1).type, 'PREPARED');
  });
  assert.equal(result.submission, 'accepted');
  assert.equal(started, true);
  assert.equal(f.live.attempts, 1);
});

test('expired or differently bound permits authorize no provider handoff', async t => {
  const f = fixture(t);
  const grant = f.permits.issue(f.op());
  assert.throws(() => f.permits.check({...f.op(), tx: {...f.op().tx, parent: head}}), /mismatched/);
  t.mock.method(Date, 'now', () => grant.expires);
  await assert.rejects(f.submit(), /expired/);
  assert.equal(f.live.attempts, 0);
  assert.equal(f.live.identityChecks, 0);
});

test('restart after permit consumption and before journal append fails closed', async t => {
  const f = fixture(t);
  f.permits.issue(f.op());
  f.permits.consume(f.op());
  await assert.rejects(f.submit(true, undefined, new AttemptPermit(f.state)), /spent/);
  assert.equal(f.live.attempts, 0);
});

test('stale parent rejects the transaction before spending its permit', async t => {
  const f = fixture(t);
  const grant = f.permits.issue(f.op());
  f.live.head = head;
  assert.equal((await f.submit()).submission, 'rejected');
  assert.equal(f.permits.check(f.op()).id, grant.id);
  assert.equal(f.live.attempts, 0);
});

test('stale local source or dependency rejects before spending the permit', async t => {
  const f = fixture(t);
  const grant = f.permits.issue(f.op());
  assert.equal((await f.submit(true, () => {throw Error('Saved source changed');})).submission, 'rejected');
  assert.equal(f.permits.check(f.op()).id, grant.id);
  assert.equal(f.live.attempts, 0);
});

test('lost acknowledgement reconciles by ancestry without another handoff after restart', async t => {
  const f = fixture(t);
  f.permits.issue(f.op());
  f.live.lostAck = true;
  assert.equal((await f.submit()).submission, 'accepted');
  assert.equal((await f.submit(true, undefined, new AttemptPermit(f.state))).submission, 'accepted');
  assert.equal(f.live.attempts, 1);
  assert.ok(f.engine().journal.read(operationId).records.some(row => row.type === 'UNKNOWN'));
});

test('legacy confirmation route cannot use a direct permit', async t => {
  const f = fixture(t);
  f.permits.issue(f.op());
  await assert.rejects(f.submit(false), /only valid for direct Publish/);
  assert.equal(f.live.attempts, 0);
  const {createPublisher} = require(base + 'service.cjs');
  const manuscript = '---\ntitle: Fixture\ndraft: true\n---\n\nFixture\n';
  const revision = 'LOCAL:' + sourceHash;
  const pub = createPublisher({
    root: f.state, stateRoot: path.join(f.state, 'http-state'), controlledAttempts: true,
    provider: f.provider, catalog: () => [{path: entry}],
    storage: {readLocalFile: () => ({sha: revision, content: manuscript})},
  });
  async function request(url, {method='GET', cookie, data} = {}) {
    const req = Readable.from(data ? [JSON.stringify(data)] : []);
    Object.assign(req, {url, method, headers: {host:'localhost:1314', origin:'http://localhost:1314', cookie, 'content-type':'application/json'}});
    const res = {headers:{}, setHeader(key,value){this.headers[key]=value;}, writeHead(status){this.status=status;}, end(body){this.body=body;}};
    await pub.handle(req,res);
    return res;
  }
  const review = await request('/publishing/review?path='+encodeURIComponent(entry)+'&sha='+revision+'&ticket='+'a'.repeat(48));
  assert.equal(review.status, 200, review.body);
  const cookie = review.headers['Set-Cookie'].split(';')[0];
  const session = await request('/publishing/session',{cookie});
  const result = await request('/publishing/confirm',{method:'POST',cookie,data:{csrf:JSON.parse(session.body).csrf}});
  assert.equal(result.status,403);
  assert.match(result.body,/only valid for direct Publish/);
});

test('credential stays private and a dedicated provider verifies account and repository', async t => {
  const f = fixture(t);
  const file = path.join(f.state, 'credential');
  const load = privateCredential(file);
  assert.throws(load, /ENOENT/);
  fs.writeFileSync(file, fakeToken, {mode:0o600});
  const calls = [];
  const transport = async req => {
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.Authorization, 'Bearer '+fakeToken);
    calls.push(req.url);
    const user = req.url.endsWith('/user');
    return {status:200,body:user?{id:123,login:'fixture'}:{
      node_id:'fixture-repo', full_name:'synthetic/desk', default_branch:'main', permissions:{push:true},
    }};
  };
  const provider = new GitHubProvider({...target, transport, credential:load, expectedIdentity});
  assert.equal(PRODUCTION_WRITES_ENABLED,true);
  assert.equal(provider.writesEnabled, false);
  assert.deepEqual(calls, []);
  await provider.verifyIdentity();
  assert.equal(calls.length, 2);
  await assert.rejects(provider.request('POST','/graphql',{}), /disabled/);
  assert.equal(calls.length, 2);
  const wrong = new GitHubProvider({...target, transport, credential:load, expectedIdentity:{...expectedIdentity,userId:999}});
  await assert.rejects(wrong.verifyIdentity(), /did not match/);
  fs.chmodSync(file,0o644);
  assert.throws(load,/Unsafe publication credential/);
  assert.deepEqual(probe,{file:'/usr/bin/hugo',args:['version'],env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
});

test('controlled startup requires a private config and grants no general write access', async t => {
  const {publicationOptions} = require(base + 'controlled-startup.cjs');
  const f = fixture(t);
  const config = path.join(f.state, 'config.json');
  const credential = path.join(f.state, 'credential');
  fs.writeFileSync(config, JSON.stringify({credentialFile:credential,...expectedIdentity}), {mode:0o600});
  const calls = [];
  let repositoryId = 'wrong-repo';
  const transport = async req => {
    calls.push(req.method);
    assert.equal(req.headers.Authorization, 'Bearer '+fakeToken);
    return {status:200,body:req.url.endsWith('/user')?{id:123,login:'fixture'}:{
      node_id:repositoryId, full_name:'synthetic/desk', default_branch:'main', permissions:{push:true},
    }};
  };
  assert.deepEqual(publicationOptions([],target,transport),{});
  const {provider, controlledAttempts} = publicationOptions(['--controlled-publish-config',config],target,transport);
  assert.equal(controlledAttempts,true);
  assert.equal(provider.writesEnabled,false);
  assert.deepEqual(calls,[]);
  await assert.rejects(provider.request('POST','/graphql',{}),/disabled/);
  assert.deepEqual(calls,[]);
  fs.writeFileSync(credential,fakeToken,{mode:0o600});
  await assert.rejects(provider.verifyIdentity(),/did not match/);
  repositoryId=expectedIdentity.repositoryId;
  assert.deepEqual(await provider.verifyIdentity(),expectedIdentity);
  await assert.rejects(provider.verifyIdentity({...expectedIdentity,userId:999}),/changed after preparation/);
  assert.deepEqual(calls,['GET','GET','GET','GET']);
});
