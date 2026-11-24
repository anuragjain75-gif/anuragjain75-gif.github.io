'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {privateRoot} = require('./private-scratch.cjs');

function readPrivateFile(file, limit, decode, label='file') {
  if (!path.isAbsolute(file)) throw Error('An absolute private file path is required');
  privateRoot(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let bytes;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o077 || st.size > limit) {
      throw Error('Unsafe publication '+label);
    }
    bytes = fs.readFileSync(fd);
    return decode(bytes);
  } finally {
    bytes?.fill(0);
    fs.closeSync(fd);
  }
}

function privateCredential(file) {
  if (!path.isAbsolute(file)) throw Error('An absolute private credential path is required');
  return () => readPrivateFile(file, 4096, bytes => {
    const token = bytes.toString('utf8').trim();
    if (!/^[A-Za-z0-9_]+$/.test(token)) throw Error('Invalid publication credential');
    return token;
  }, 'credential file');
}

module.exports = {privateCredential, readPrivateFile};
