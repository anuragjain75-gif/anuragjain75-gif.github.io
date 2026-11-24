const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto'),vm=require('vm');
const {createDeleteService,TYPES,entryPath}=require('../../scripts/editor-delete.js');
const api=fs.readFileSync(path.join(__dirname,'../../scripts/editor-api.js'),'utf8');
function fixture(options={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lilamaya-delete-fixture-'));
 const primitives=vm.runInNewContext(api.slice(api.indexOf('function storageError('),api.indexOf('function denyRemoteMutation('))+'\n({directory,snapshot,writeExclusive,readLocalFile,saveLocalFile})',{fs,nodePath:path,crypto,repositoryRoot:root,console});
 const service=createDeleteService({...primitives,...options});
 function put(p,bytes='---\r\ntitle: "Synthetic Śāntiḥ"\r\ndraft: true\r\n---\r\nBody  \r\n{{< poetry >}}\r\nSafe\r\n{{< /poetry >}}\r\n'){fs.mkdirSync(path.dirname(root+'/'+p),{recursive:true});fs.writeFileSync(root+'/'+p,bytes);return primitives.readLocalFile(p).sha;}
 return {root,...primitives,service,put};
}
for(const type of Object.keys(TYPES))for(const bundle of [true,false])test('Recover '+type+' '+(bundle?'bundle':'standalone'),()=>{
 const f=fixture(),p=`content/${type}/synthetic${bundle?'/index':''}.md`,sha=f.put(p),before=fs.readFileSync(f.root+'/'+p);
 const unrelated='content/ideas/unrelated/index.md';f.put(unrelated,'---\ntitle: Unrelated\n---\nUntouched');
 if(bundle){f.put(path.dirname(p)+'/images/test.png',Buffer.from([137,80,78,71]));f.put(path.dirname(p)+'/original.bak','Back up');}
 const review=f.service.prepare(p,sha,'Synthetic Śāntiḥ');assert.equal(review.kind,TYPES[type]);assert.ok(review.files.includes(p));
 const result=f.service.execute({token:review.token,path:p,sha,confirmation:'DELETE'});assert.equal(result.ok,true);assert.equal(fs.existsSync(f.root+'/'+p),false);
 const base=f.root+'/'+result.recoveryPath;assert.deepEqual(fs.readFileSync(base+'/'+(bundle?'entry/index.md':'entry')),before);assert.equal(JSON.parse(fs.readFileSync(base+'/complete.json')).verified,true);
 assert.equal(fs.readFileSync(f.root+'/'+unrelated,'utf8'),'---\ntitle: Unrelated\n---\nUntouched');
 if(bundle){assert.deepEqual(fs.readFileSync(base+'/entry/images/test.png'),Buffer.from([137,80,78,71]));assert.equal(fs.readFileSync(base+'/entry/original.bak','utf8'),'Back up');assert.ok(fs.existsSync(base+'/entry/.index.md.save-lock'));}
 assert.equal(fs.statSync(f.root+'/backups/editor-deleted').mode&0o777,0o700);
 assert.throws(()=>f.service.execute({token:review.token,path:p,sha,confirmation:'DELETE'}),/invalid/);
});
for(const p of ['../essay.md','/content/essays/x/index.md','content/essays/../x.md','content/essays/nested/x/index.md','content/unknown/x.md','content/essays/_index.md','content/essays/x/INDEX.md','content/essays/x/index.md\0'])test('Reject path '+JSON.stringify(p),()=>assert.throws(()=>entryPath(p)));
for(const defect of ['stale','asset','symlink','ancestor-symlink','nested-entry','hidden','lock','hardlink','busy'])test('Fail closed '+defect,()=>{
 let occupied=false;const f=fixture({busy:()=>occupied}),p='content/essays/x/index.md',sha=f.put(p),before=fs.readFileSync(f.root+'/'+p),review=f.service.prepare(p,sha,'X');
 if(defect==='stale')fs.appendFileSync(f.root+'/'+p,'changed');
 if(defect==='asset')f.put('content/essays/x/hero.png','new asset');
 if(defect==='symlink')fs.symlinkSync('/tmp',f.root+'/content/essays/x/link');
 if(defect==='ancestor-symlink'){fs.renameSync(f.root+'/content/essays/x',f.root+'/actual');fs.symlinkSync(f.root+'/actual',f.root+'/content/essays/x');}
 if(defect==='nested-entry')f.put('content/essays/x/other.md');
 if(defect==='hidden')f.put('content/essays/x/.unknown');
 if(defect==='lock')fs.mkdirSync(f.root+'/content/essays/x/.index.md.save-lock');
 if(defect==='hardlink')fs.linkSync(f.root+'/'+p,f.root+'/content/essays/x/shared');
 if(defect==='busy')occupied=true;
 assert.throws(()=>f.service.execute({token:review.token,path:p,sha,confirmation:'DELETE'}));assert.ok(fs.existsSync(f.root+'/'+p));if(defect!=='stale')assert.deepEqual(fs.readFileSync(f.root+'/'+p),before);
});
test('Cancel creates no backup or lock',()=>{const f=fixture(),p='content/fragments/x.md',sha=f.put(p);f.service.prepare(p,sha,'X');assert.equal(fs.existsSync(f.root+'/backups'),false);assert.ok(fs.existsSync(f.root+'/'+p));});
test('Expired review rejected',()=>{let now=0;const f=fixture({clock:()=>now}),p='content/works/x/index.md',sha=f.put(p),review=f.service.prepare(p,sha,'X');now=300001;assert.throws(()=>f.service.execute({token:review.token,path:p,sha,confirmation:'DELETE'}),/expired/);});
for(const defect of ['collision','preparation','move','post-move'])test('Recoverable failure '+defect,()=>{
 const id='11111111-1111-4111-8111-111111111111';const f=fixture({uuid:()=>id,...(defect==='move'?{move:()=>{throw Error('Injected move failure');}}:defect==='post-move'?{move:({sourceFD,recoveryFD,source})=>{fs.renameSync(`/proc/self/fd/${sourceFD}/${source}`,`/proc/self/fd/${recoveryFD}/entry`);throw Error('Injected acknowledgment failure');}}:{})});
 const p='content/fragments/x/index.md',sha=f.put(p),bytes=fs.readFileSync(f.root+'/'+p),review=f.service.prepare(p,sha,'X');
 if(defect==='collision'){fs.mkdirSync(f.root+'/backups/editor-deleted/'+id,{recursive:true,mode:0o700});fs.writeFileSync(f.root+'/backups/editor-deleted/'+id+'/retained','Keep');}
 if(defect==='preparation')fs.writeFileSync(f.root+'/backups','Not a directory');
 let error;try{f.service.execute({token:review.token,path:p,sha,confirmation:'DELETE'});}catch(e){error=e;}assert.ok(error);assert.equal(error.deleteOutcome,['move','post-move'].includes(defect)?'uncertain':'unchanged');
 assert.deepEqual(fs.readFileSync(defect==='post-move'?f.root+'/backups/editor-deleted/'+id+'/entry/index.md':f.root+'/'+p),bytes);
 if(defect==='collision')assert.equal(fs.readFileSync(f.root+'/backups/editor-deleted/'+id+'/retained','utf8'),'Keep');
 if(['move','post-move'].includes(defect))assert.ok(fs.existsSync(f.root+'/backups/editor-deleted/.operation-lock'));
});
test('Old pinned bundle cannot acquire a save/upload lock after move',()=>{const f=fixture(),p='content/fragments/x/index.md',sha=f.put(p),pinned=f.directory(path.dirname(p)),review=f.service.prepare(p,sha,'X');try{f.service.execute({token:review.token,path:p,sha,confirmation:'DELETE'});assert.throws(()=>fs.mkdirSync(pinned.path+'/.index.md.save-lock'),/EEXIST/);}finally{pinned.close();}});
test('Incoming connections never cascade',()=>{const items=[{path:'content/people/ref/index.md',title:'Reference'}],f=fixture({incoming:()=>({items,complete:false})}),p='content/ideas/x/index.md',sha=f.put(p);f.put(items[0].path,'---\ntitle: Reference\nconnections: [{target: /ideas/x/}]\n---\nKeep');const before=fs.readFileSync(f.root+'/'+items[0].path),review=f.service.prepare(p,sha,'X');assert.deepEqual(review.references.items,items);f.service.execute({token:review.token,path:p,sha,confirmation:'DELETE'});assert.deepEqual(fs.readFileSync(f.root+'/'+items[0].path),before);});
test('Global deletion lock rejects another entry',()=>{const f=fixture(),p='content/places/x.md',sha=f.put(p),review=f.service.prepare(p,sha,'X');fs.mkdirSync(f.root+'/backups/editor-deleted/.operation-lock',{recursive:true,mode:0o700});assert.throws(()=>f.service.execute({token:review.token,path:p,sha,confirmation:'DELETE'}),/Another deletion/);assert.ok(fs.existsSync(f.root+'/'+p));assert.equal(fs.existsSync(f.root+'/content/places/.x.md.save-lock'),false);});
test('Standalone shared inode rejected',()=>{const f=fixture(),p='content/fragments/x.md',sha=f.put(p);fs.linkSync(f.root+'/'+p,f.root+'/content/fragments/shared');assert.throws(()=>f.service.prepare(p,sha,'X'));});
test('Required exact confirmation and review identity',()=>{const f=fixture(),p='content/people/x.md',sha=f.put(p),r=f.service.prepare(p,sha,'X');for(const change of [{confirmation:'delete'},{path:'content/people/other.md'},{sha:'LOCAL:'+'0'.repeat(64)},{token:'unknown'}])assert.throws(()=>f.service.execute({token:r.token,path:p,sha,confirmation:'DELETE',...change}));assert.ok(fs.existsSync(f.root+'/'+p));});
test('Payload collision is never overwritten',()=>{
 const f=fixture();const realWrite=f.writeExclusive;
 const service=createDeleteService({...f,writeExclusive:(name,bytes)=>{const result=realWrite(name,bytes);if(name.endsWith('/manifest.json'))fs.writeFileSync(path.dirname(name)+'/entry','Existing recovery payload');return result;}});
 const p='content/fragments/x.md',sha=f.put(p),before=fs.readFileSync(f.root+'/'+p),r=service.prepare(p,sha,'X');let error;
 try{service.execute({token:r.token,path:p,sha,confirmation:'DELETE'});}catch(e){error=e;}
 assert.equal(error.deleteOutcome,'uncertain');assert.deepEqual(fs.readFileSync(f.root+'/'+p),before);
 const directory=f.root+'/backups/editor-deleted/'+error.recoveryId;assert.equal(fs.readFileSync(directory+'/entry','utf8'),'Existing recovery payload');assert.equal(fs.existsSync(directory+'/complete.json'),false);
});
test('Cross-filesystem recovery rejected before move',()=>{
 const f=fixture(),p='content/fragments/x.md',sha=f.put(p),other=fs.mkdtempSync('/dev/shm/lilamaya-delete-fixture-');
 if(fs.statSync(f.root).dev===fs.statSync(other).dev)return assert.fail('Cross-filesystem fixture unavailable');
 const service=createDeleteService({...f,directory:(relative,create)=>{
  if(relative==='backups/editor-deleted'){const fd=fs.openSync(other,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);return {fd,path:`/proc/self/fd/${fd}`,close(){fs.closeSync(fd);}};}
  return f.directory(relative,create);
 }});const r=service.prepare(p,sha,'X');assert.throws(()=>service.execute({token:r.token,path:p,sha,confirmation:'DELETE'}),/same filesystem/);assert.ok(fs.existsSync(f.root+'/'+p));
});
test('Changed payload during move cannot receive success',()=>{
 const f=fixture(),p='content/ideas/x/index.md',sha=f.put(p);
 const service=createDeleteService({...f,move:({sourceFD,recoveryFD,source})=>{fs.appendFileSync(`/proc/self/fd/${sourceFD}/${source}/index.md`,'Concurrent edit');fs.renameSync(`/proc/self/fd/${sourceFD}/${source}`,`/proc/self/fd/${recoveryFD}/entry`);}}),r=service.prepare(p,sha,'X');let error;
 try{service.execute({token:r.token,path:p,sha,confirmation:'DELETE'});}catch(e){error=e;}
 assert.equal(error.deleteOutcome,'uncertain');const dir=f.root+'/backups/editor-deleted/'+error.recoveryId;assert.ok(fs.readFileSync(dir+'/entry/index.md','utf8').endsWith('Concurrent edit'));assert.equal(fs.existsSync(dir+'/complete.json'),false);
});
test('An actual held social-card flock prevents the move',async()=>{
 const {spawn}=require('child_process'),f=fixture(),p='content/essays/x/index.md',sha=f.put(p),locks=f.root+'/backups/editor-derived/social-cards/locks';fs.mkdirSync(locks,{recursive:true});
 const worker=spawn('/usr/bin/python3',['-u','-c','import fcntl,sys,time\nf=open(sys.argv[1],"a")\nfcntl.flock(f,fcntl.LOCK_EX)\nprint("ready",flush=True)\ntime.sleep(15)',locks+'/essays-x.lock'],{stdio:['ignore','pipe','pipe']});
 try{
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Synthetic card lock readiness timeout')),3000);worker.stdout.once('data',()=>{clearTimeout(timeout);resolve();});worker.once('error',reject);});
  const r=f.service.prepare(p,sha,'X');assert.throws(()=>f.service.execute({token:r.token,path:p,sha,confirmation:'DELETE'}));assert.ok(fs.existsSync(f.root+'/'+p));
 }finally{worker.kill('SIGTERM');}
});
