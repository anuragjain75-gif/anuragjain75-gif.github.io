'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const project = path.resolve(__dirname, '../..');
const workspace = path.basename(project) === 'app' && fs.existsSync(path.join(project, '../.git'))
  ? path.dirname(project) : project;
const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

function startTime(pid) {
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}

function hasGitMetadata(dir) {
  const marker = path.join(dir, '.git');
  const stat = fs.lstatSync(marker, {throwIfNoEntry: false});
  if (stat?.isDirectory()) return fs.existsSync(path.join(marker, 'HEAD'));
  if (stat?.isFile()) return fs.readFileSync(marker, 'utf8').startsWith('gitdir: ');
  return Boolean(stat?.isSymbolicLink());
}

function privateRoot(root) {
  root = path.resolve(root);
  for (let dir = root; ; dir = path.dirname(dir)) {
    if (dir === workspace || hasGitMetadata(dir)) {
      throw Error('Publishing state must be outside the Git worktree');
    }
    try {
      if (!fs.lstatSync(dir).isDirectory()) throw Error('Publishing state needs nonsymlink directories');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (dir === path.dirname(dir)) break;
  }
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  const stat = fs.lstatSync(root);
  if (fs.realpathSync(root) !== root || !stat.isDirectory() ||
      stat.uid !== process.getuid() || stat.mode & 0o077) {
    throw Error('Publishing state needs a private, owner-controlled nonsymlink directory');
  }
  return root;
}

function defaultStateRoot() {
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'),
    'lilamaya-writing-desk/publishing');
}

function withPrivateScratch(purpose, action) {
  const root = privateRoot(path.join(privateRoot(defaultStateRoot()), 'scratch'));
  for (const name of fs.readdirSync(root)) {
    const match = /^(?:catalog|inventory)-([a-f0-9-]{36})-(\d+)-(\d+)-[A-Za-z0-9]{6}$/.exec(name);
    if (!match || (match[1] === boot && startTime(match[2]) === match[3])) continue;
    const abandoned = path.join(root, name);
    const stat = fs.lstatSync(abandoned, {throwIfNoEntry: false});
    if (stat?.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o077)) {
      fs.rmSync(abandoned, {recursive: true, force: true});
    }
  }
  const dir = fs.mkdtempSync(path.join(root, `${purpose}-${boot}-${process.pid}-${startTime(process.pid)}-`));
  try {
    return action(dir);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

module.exports = {defaultStateRoot, privateRoot, withPrivateScratch};
