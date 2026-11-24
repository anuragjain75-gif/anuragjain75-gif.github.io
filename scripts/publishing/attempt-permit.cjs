'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {privateRoot} = require('./private-scratch.cjs');
const {Journal, writeExclusive} = require('./engine/operation-journal.cjs');
const {safePath, canonical} = require('./engine/editor-publish.cjs').internals;
const grants = new WeakMap();
// Remote identity, parent, snapshot and foundation validation can require many
// bounded read requests. Keep the permit short-lived while allowing that
// validation to finish before the durable spend.
const lifetime = 15 * 60 * 1000;

function binding(operation) {
  const {tx, descriptor} = operation;
  const input = descriptor.plan.request.documentRequest;
  return {
    route: 'direct',
    path: safePath(input.selected),
    sourceHash: input.expectedSourceHash,
    target: tx.target,
    parent: tx.parent,
    operationId: tx.operationId,
    transactionDigest: tx.digest,
    ...(descriptor.directSource?.identity ? {identity: descriptor.directSource.identity} : {}),
  };
}

class AttemptPermit {
  constructor(stateRoot) {
    this.root = privateRoot(path.join(privateRoot(stateRoot), 'permits'));
    this.file = path.join(this.root, 'active.json');
  }

  // Operator-side only. There is no HTTP issuance route.
  issue(operation, expires = Date.now() + lifetime) {
    const issued = Date.now();
    if (!operation.descriptor.directSource || operation.current.submission !== 'not-submitted' ||
        !Number.isSafeInteger(expires) || expires <= issued || expires > issued + lifetime) {
      throw Error('A prepared direct transaction and a short permit lifetime are required');
    }
    const permit = {id: randomUUID(), issued, expires, binding: binding(operation)};
    writeExclusive(this.file, permit);
    return permit;
  }

  read() {
    let fd;
    try { fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o077 || st.size > 8192) {
        throw Error('Unsafe publication permit');
      }
      const permit = JSON.parse(fs.readFileSync(fd, 'utf8'));
      const {id, issued, expires, binding: scope} = permit;
      if (!/^[a-f0-9-]{36}$/.test(id) || !Number.isSafeInteger(issued) ||
          !Number.isSafeInteger(expires) || expires <= issued || expires > issued + lifetime ||
          !scope || !/^[a-f0-9]{64}$/.test(scope.operationId)) throw Error('Invalid publication permit');
      return permit;
    } finally { fs.closeSync(fd); }
  }

  check(operation) {
    const permit = this.read();
    const now = Date.now();
    if (!permit || permit.issued > now || permit.expires <= now ||
        canonical(permit.binding) !== canonical(binding(operation)) ||
        fs.existsSync(path.join(this.root, permit.id + '.spent.json'))) {
      throw Error('Publication permit is missing, expired, spent or mismatched');
    }
    return permit;
  }

  // Called under the publication lock. A crash between this receipt and the
  // journal entry burns the permit without authorizing a remote request.
  consume(operation) {
    const permit = this.check(operation);
    writeExclusive(path.join(this.root, permit.id + '.spent.json'), permit);
    const grant = Object.freeze({id: permit.id});
    grants.set(grant, {permit, journalRoot: path.join(path.dirname(this.root), 'journals')});
    return grant;
  }
}

// Only a grant minted by the exclusive durable spend can reach the transport.
function claimGrant(grant, tx, identity, journal) {
  const issued = grants.get(grant);
  const permit = issued?.permit;
  if (!permit || permit.expires <= Date.now() || permit.binding.operationId !== tx.operationId ||
      permit.binding.transactionDigest !== tx.digest ||
      !permit.binding.identity || canonical(permit.binding.identity) !== canonical(identity)) {
    throw Error('Production publication requires a consumed transaction permit');
  }
  if (!(journal instanceof Journal) || journal.root !== issued.journalRoot) {
    throw Error('Publication grant belongs to another journal');
  }
  const lock = JSON.parse(fs.readFileSync(path.join(journal.root, '.publisher-lock', 'owner.json'), 'utf8'));
  if (lock.pid !== process.pid || lock.operation !== tx.operationId) {
    throw Error('Publication grant requires the operation lock');
  }
  const {prepared, records} = journal.read(tx.operationId);
  const attempt = records.at(-1);
  if (attempt.type !== 'ATTEMPT_STARTED' || attempt.data.permitId !== permit.id ||
      canonical(binding(prepared)) !== canonical(permit.binding)) {
    throw Error('Publication attempt was not durably journaled');
  }
  grants.delete(grant);
}

module.exports = {AttemptPermit, claimGrant};
