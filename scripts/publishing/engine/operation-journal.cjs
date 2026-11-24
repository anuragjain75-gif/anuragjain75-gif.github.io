'use strict';
const fs=require('node:fs'),path=require('node:path');
const {hash,internals:{canonical}}=require('./editor-publish.cjs');
const locks=new Map();
async function exclusive(key,action){const old=locks.get(key)||Promise.resolve();let release;const gate=new Promise(r=>release=r);locks.set(key,old.then(()=>gate));await old;try{return await action();}finally{release();}}
function checkAncestors(p){if(!path.isAbsolute(p))throw new Error('Absolute journal root required');let current=path.parse(p).root;for(const part of p.slice(current.length).split('/').filter(Boolean)){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw new Error('Unsafe journal ancestor');}}
function readJson(p){const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size>64*1024*1024)throw new Error('Unsafe journal file');return JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}}
function writeExclusive(p,value){const fd=fs.openSync(p,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,canonical(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const d=fs.openSync(path.dirname(p),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
class Journal {
 constructor(root){checkAncestors(root);if(!fs.statSync(root).isDirectory())throw new Error('Journal directory required');this.root=root;}
 directory(id){if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Invalid operation identity');return path.join(this.root,id);}
 create(tx,descriptor){const dir=this.directory(tx.operationId);try{fs.mkdirSync(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;const old=this.read(tx.operationId);if(old.prepared.tx.digest!==tx.digest)throw new Error('Operation identity reused with different result');return old;}
  const parentFd=fs.openSync(this.root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(parentFd);}finally{fs.closeSync(parentFd);}
  const body={version:5,tx,descriptor};writeExclusive(path.join(dir,'prepared.json'),{...body,integrity:hash(canonical(body))});this.append(tx.operationId,'PREPARED',{status:'DEFINITELY_NOT_SUBMITTED'});return this.read(tx.operationId);
 }
 read(id){const dir=this.directory(id);checkAncestors(dir);const prepared=readJson(path.join(dir,'prepared.json'));const p={...prepared};delete p.integrity;if(hash(canonical(p))!==prepared.integrity||prepared.tx.operationId!==id)throw new Error('Journal prepared integrity failure');
  const names=fs.readdirSync(dir).filter(n=>n!=='prepared.json').sort();let previous=prepared.integrity;const records=[];
  for(let i=0;i<names.length;i++){if(names[i]!==String(i).padStart(6,'0')+'.json')throw new Error('Journal sequence/unknown-file failure');const entry=readJson(path.join(dir,names[i])),body={...entry};delete body.integrity;
   if(entry.sequence!==i||entry.previous!==previous||entry.integrity!==hash(canonical(body)))throw new Error('Journal record integrity failure');previous=entry.integrity;records.push(entry);}
  if(!records.length)throw new Error('Incomplete journal; explicit review required');return {prepared,records};
 }
 append(id,type,data){const dir=this.directory(id);let previous,sequence;
  if(type==='PREPARED'){const p=readJson(path.join(dir,'prepared.json'));previous=p.integrity;sequence=0;}
  else{const old=this.read(id);sequence=old.records.length;previous=old.records.at(-1).integrity;}
  const body={sequence,previous,type,data};writeExclusive(path.join(dir,String(sequence).padStart(6,'0')+'.json'),{...body,integrity:hash(canonical(body))});
 }
 withOperation(id,action){return exclusive(this.directory(id),action);}
}
module.exports={Journal,writeExclusive};
