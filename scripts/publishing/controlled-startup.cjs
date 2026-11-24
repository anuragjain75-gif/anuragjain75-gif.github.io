'use strict';

const {GitHubProvider} = require('./github-provider.cjs');
const {privateCredential, readPrivateFile} = require('./private-credential.cjs');

function publicationOptions(args, target, transport) {
  if (!args.length) return {};
  if (args.length !== 2 || args[0] !== '--controlled-publish-config') {
    throw Error('Expected --controlled-publish-config followed by an absolute private configuration path');
  }
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
    throw Error('Remove GitHub token environment variables before controlled publication startup');
  }
  const {credentialFile, userId, login, repositoryId} = readPrivateFile(args[1], 8192, bytes => {
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { throw Error('Invalid controlled publication configuration JSON'); }
  });
  if (typeof credentialFile !== 'string' || !Number.isSafeInteger(userId) || userId < 1 ||
      typeof login !== 'string' || !/^[-A-Za-z0-9]+$/.test(login) ||
      typeof repositoryId !== 'string' || !/^[A-Za-z0-9_=-]+$/.test(repositoryId)) {
    throw Error('A private credential path, GitHub user ID, login and repository node ID are required');
  }
  const provider = new GitHubProvider({
    ...target, transport, credential: privateCredential(credentialFile),
    expectedIdentity: {userId, login, repositoryId}, controlled: true,
  });
  return {provider, controlledAttempts: true};
}

module.exports = {publicationOptions};
