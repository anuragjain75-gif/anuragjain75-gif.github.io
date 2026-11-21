'use strict';
// Local, recoverable entry moves. Never invokes Git, network, pruning or rm -r.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {execFileSync} = require('child_process');
const TYPES = Object.freeze({essays:'Essay', fragments:'Fragment', paintings:'Painting', people:'Person', works:'Work', ideas:'Idea', traditions:'Tradition', places:'Place', journeys:'Journey'});
const failure = (statusCode, message) => Object.assign(new Error(message), {statusCode});
const same = (a,b) => a.dev === b.dev && a.ino === b.ino;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const RECOVERY = 'backups/editor-deleted';
function entryPath(value) {
  if (typeof value !== 'string' || !/^content\/[a-z]+\/[a-z0-9][a-z0-9-]*(?:\/index)?\.md$/.test(value) || !TYPES[value.split('/')[1]]) {
    throw failure(400, 'Only a top-level Markdown entry or an unambiguous leaf page bundle is supported.');
  }
  const [,type,slug] = value.split('/'), bundle = value.endsWith('/index.md');
  return {path:value, type, kind:TYPES[type], bundle, source:bundle ? slug : path.basename(value), parent:bundle ? `content/${type}` : path.dirname(value)};
}
function atomicMove({sourceFD, recoveryFD, source, cardFD}) {
  execFileSync('/usr/bin/python3', [path.join(__dirname,'editor-delete-move.py'), source, 'entry'], {
    env:{PATH:'/usr/bin:/bin', LANG:'C.UTF-8', ...(cardFD === undefined ? {} : {CARD_LOCK:'1'})},
    stdio:['ignore','pipe','pipe',sourceFD,recoveryFD,...(cardFD === undefined ? [] : [cardFD])],
    timeout:10000, maxBuffer:16384
  });
}
function createDeleteService({directory, snapshot, writeExclusive, busy=()=>false, incoming=()=>({items:[],complete:false}), clock=Date.now, uuid=crypto.randomUUID, move=atomicMove}) {
  const reviews = new Map();
  function inventory(root, bundle, ignore) {
    const rows=[]; let bytes=0, count=0;
    function visit(full, relative) {
      const stat=fs.lstatSync(full);
      if (ignore && relative === '.index.md.save-lock' && same(stat,ignore) && stat.isDirectory()) return;
      if (++count > 10000 || /[\x00-\x1f\x7f\\]/.test(relative) || relative.split('/').some(p=>p.startsWith('.'))) throw failure(409,'Unexpected resource or recovery lock; manual review is required.');
      if (stat.isSymbolicLink()) throw failure(403,'Symbolic links are not supported.');
      if (stat.isDirectory()) {
        if (!bundle) throw failure(409,'Expected a standalone regular file.');
        const fd=fs.openSync(full,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
        try {
          if (!same(stat,fs.fstatSync(fd))) throw failure(409,'Resource directory changed.');
          rows.push({path:relative,directory:true,dev:stat.dev,ino:stat.ino,mode:stat.mode});
          for (const name of fs.readdirSync(`/proc/self/fd/${fd}`).sort()) visit(`/proc/self/fd/${fd}/${name}`,`${relative}/${name}`);
        } finally {fs.closeSync(fd);}
      } else if (stat.isFile() && stat.nlink === 1) {
        if (bundle && /\.md$/i.test(relative) && relative !== 'index.md') throw failure(409,'Bundle contains another Markdown entry; ownership is ambiguous.');
        const file=snapshot(full);
        try {
          bytes+=file.stat.size;
          if (bytes > 256*1024*1024) throw failure(413,'Entry exceeds the recovery inventory limit.');
          rows.push({path:relative,dev:file.stat.dev,ino:file.stat.ino,mode:file.stat.mode,size:file.stat.size,mtime:file.stat.mtimeMs,sha256:digest(file.bytes)});
        } finally {file.close();}
      } else throw failure(403,'Only entry-owned regular files and directories are supported.');
    }
    if (bundle) {
      const fd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
      try {for (const name of fs.readdirSync(`/proc/self/fd/${fd}`).sort()) visit(`/proc/self/fd/${fd}/${name}`,name);} finally {fs.closeSync(fd);}
    } else visit(root,path.basename(root));
    return rows;
  }
  function inspect(value, revision, ignore=null) {
    const entry=entryPath(value);
    if (!/^LOCAL:[a-f0-9]{64}$/.test(revision || '')) throw failure(409,'A current local revision is required.');
    if (busy(value)) throw failure(409,'Wait for the current document operation to finish.');
    const parent=directory(entry.parent); let docDir;
    try {
      const root=`${parent.path}/${entry.source}`, stat=fs.lstatSync(root);
      if (stat.isSymbolicLink() || !(entry.bundle ? stat.isDirectory() : stat.isFile())) throw failure(403,'Unexpected entry structure.');
      docDir=directory(path.dirname(value));
      const lock=`${docDir.path}/.${path.basename(value)}.save-lock`;
      if (fs.existsSync(lock) && (!ignore || !same(fs.lstatSync(lock),ignore))) throw failure(409,'A save, deletion or recovery lock exists.');
      const file=snapshot(`${docDir.path}/${path.basename(value)}`);
      try {if (file.sha !== revision) throw failure(409,'The document changed since it was opened. Preserve the draft and review disk.');} finally {file.close();}
      const files=inventory(root,entry.bundle,ignore);
      return {entry,files,identity:JSON.stringify({root:[stat.dev,stat.ino],files})};
    } finally {docDir?.close();parent.close();}
  }
  function prepare(value, revision, title) {
    const checked=inspect(value,revision);
    // Preparation is read-only. Cancel creates no backup, lock or filesystem change.
    let recovery;
    try {recovery=directory(RECOVERY);if(fs.existsSync(`${recovery.path}/.operation-lock`))throw failure(409,'Another deletion or recovery is in progress.');}
    catch(error){if(error.code!=='ENOENT')throw error;}finally{recovery?.close();}
    for (const [token,r] of reviews) if (r.expires <= clock()) reviews.delete(token);
    if (reviews.size >= 32) throw failure(429,'Too many pending deletion reviews.');
    const token=crypto.randomBytes(32).toString('hex');
    const review={token,path:value,revision,title:typeof title==='string'?title:'Untitled',type:checked.entry.type,kind:checked.entry.kind,expires:clock()+300000,
      files:checked.files.filter(f=>!f.directory).map(f=>checked.entry.bundle ? path.dirname(value)+'/'+f.path : value),references:incoming(value)};
    reviews.set(token,{...review,checked});
    return review;
  }
  function execute({token,path:value,sha,confirmation}) {
    const review=reviews.get(token);
    if (!review || review.expires <= clock() || review.path !== value || review.revision !== sha || confirmation !== 'DELETE') throw failure(409,'Deletion review is invalid or expired. Review again.');
    reviews.delete(token);
    const before=inspect(value,sha);
    if (before.identity !== review.checked.identity) throw failure(409,'Entry resources changed after review.');
    const {entry}=before, docDir=directory(path.dirname(value)), parent=directory(entry.parent);
    const lock=`${docDir.path}/.${path.basename(value)}.save-lock`;
    let lockIdentity, globalIdentity, base, recovery, cardDir, cardFD, attempted=false, complete=false, id;
    try {
      try {fs.mkdirSync(lock,{mode:0o700});lockIdentity=fs.lstatSync(lock);} catch(error){if(error.code==='EEXIST')throw failure(409,'Another writer or recovery owns this entry.');throw error;}
      if (inspect(value,sha,lockIdentity).identity !== before.identity) throw failure(409,'Entry changed during recovery preparation.');
      base=directory(RECOVERY,true);
      if (fs.fstatSync(base.fd).dev !== fs.fstatSync(parent.fd).dev) throw failure(503,'Recovery requires the same filesystem.');
      if (fs.fstatSync(base.fd).mode & 0o077) throw failure(403,'Recovery directory must be private (0700).');
      try {fs.mkdirSync(`${base.path}/.operation-lock`,{mode:0o700});globalIdentity=fs.lstatSync(`${base.path}/.operation-lock`);} catch(error){if(error.code==='EEXIST')throw failure(409,'Another deletion or recovery is in progress.');throw error;}
      id=uuid();if(!/^[a-f0-9-]{36}$/.test(id))throw failure(500,'Invalid recovery identifier.');
      fs.mkdirSync(`${base.path}/${id}`,{mode:0o700});recovery=directory(`${RECOVERY}/${id}`);
      const manifest={version:1,id,originalPath:value,title:review.title,type:entry.type,revision:sha,created:new Date(clock()).toISOString(),bundle:entry.bundle,inventory:before.files,
        retainedLock:entry.bundle ? {name:'.index.md.save-lock',dev:lockIdentity.dev,ino:lockIdentity.ino} : null};
      writeExclusive(`${recovery.path}/manifest.json`,JSON.stringify(manifest,null,2));fs.fsyncSync(recovery.fd);fs.fsyncSync(base.fd);
      if (['essays','paintings'].includes(entry.type) && entry.bundle) {
        cardDir=directory('backups/editor-derived/social-cards/locks',true);
        cardFD=fs.openSync(`${cardDir.path}/${entry.type}-${entry.source}.lock`,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK,0o600);
        if (!fs.fstatSync(cardFD).isFile()) throw failure(409,'Unsafe social-card operation lock.');
      }
      // Revalidate source revision, offsets-independent inventory and ownership immediately before rename.
      if (inspect(value,sha,lockIdentity).identity !== before.identity) throw failure(409,'Entry changed before the recovery move.');
      attempted=true;
      move({sourceFD:parent.fd,recoveryFD:recovery.fd,source:entry.source,cardFD});
      if (fs.existsSync(`${parent.path}/${entry.source}`)) throw failure(409,'An entry exists at the former source path.');
      let recovered=inventory(`${recovery.path}/entry`,entry.bundle,entry.bundle?lockIdentity:null);
      // A standalone payload is deliberately named "entry" inside recovery.
      if (!entry.bundle) recovered=recovered.map(f=>({...f,path:entry.source}));
      if (JSON.stringify(recovered) !== JSON.stringify(before.files)) throw failure(409,'Recovery inventory or source bytes changed.');
      writeExclusive(`${recovery.path}/complete.json`,JSON.stringify({id,verified:true,completed:new Date(clock()).toISOString()}));fs.fsyncSync(recovery.fd);
      complete=true;
      return {ok:true,deleted:true,path:value,recoveryId:id,recoveryPath:`${RECOVERY}/${id}`,local:true};
    } catch(error) {
      error.deleteOutcome=attempted?'uncertain':'unchanged';
      if(id)error.recoveryId=id;
      throw error;
    } finally {
      // A moved bundle retains a tombstone lock: a delayed writer may still hold
      // its former directory FD. Never let that writer change the recovery payload.
      if (lockIdentity && (!attempted || !entry.bundle)) {
        try {if(same(fs.lstatSync(lock),lockIdentity))fs.rmdirSync(lock);} catch{/* Retain unexpected recovery state. */}
      }
      if (globalIdentity && (!attempted || complete)) {
        try {const name=`${base.path}/.operation-lock`;if(same(fs.lstatSync(name),globalIdentity))fs.rmdirSync(name);}catch{/* Manual review required; no unrelated cleanup. */}
      }
      if(cardFD!==undefined)fs.closeSync(cardFD);cardDir?.close();recovery?.close();base?.close();parent.close();docDir.close();
    }
  }
  return {prepare,execute};
}
module.exports={TYPES,entryPath,createDeleteService};
