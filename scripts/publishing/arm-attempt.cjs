'use strict';

// Local operator command. No provider or credential access.
const path = require('node:path');
const {AttemptPermit} = require('./attempt-permit.cjs');
const {defaultStateRoot} = require('./private-scratch.cjs');
const {locked} = require('./process-lock.cjs');
const {Engine} = require('./engine/transaction-engine.cjs');

async function main(args) {
  const [mode, id] = args;
  if (args.length !== 2 || !['--inspect', '--arm'].includes(mode) || !/^[a-f0-9]{64}$/.test(id)) {
    throw Error('Usage: node scripts/publishing/arm-attempt.cjs --inspect|--arm OPERATION_ID');
  }
  const state = defaultStateRoot();
  const engine = new Engine(path.join(state, 'journals'));
  await locked(engine.journal.root, 'permit-operator', () => {
    const op = engine.load(id);
    const source = op.descriptor.directSource;
    if (!source?.identity || op.current.submission !== 'not-submitted') {
      throw Error('A prepared controlled direct transaction is required');
    }
    const tx = op.tx;
    const document = op.descriptor.plan.request.documentRequest;
    const destination = new URL(tx.expectedLive.url, tx.expectedLive.siteOrigin);
    if (destination.origin !== tx.expectedLive.siteOrigin) throw Error('Invalid publication destination');
    const summary = {
      operationId: id, transactionDigest: tx.digest, commit: tx.commit, target: tx.target,
      identity: source.identity, parent: tx.parent, path: document.selected,
      savedRevision: source.revision, sourceHash: document.expectedSourceHash,
      destination: destination.href, files: tx.files.map(file => ({path: file.path, action: file.action})),
    };
    if (mode === '--arm') summary.permitExpires = new Date(new AttemptPermit(state).issue(op).expires).toISOString();
    console.log(JSON.stringify(summary, null, 2));
  });
}

main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
