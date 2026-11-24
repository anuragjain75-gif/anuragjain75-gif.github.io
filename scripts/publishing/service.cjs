'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),cp=require('child_process');
const core=require('./engine/editor-publish.cjs'),{hash,internals:{canonical,read}}=core;
const profiles=require('./profiles.cjs'),foundation=require('./desk-foundation.cjs');
const {readRemote}=require('./engine/mock-git.cjs'),{Engine}=require('./engine/transaction-engine.cjs');
const {GitHubProvider}=require('./github-provider.cjs'),{locked,recover}=require('./process-lock.cjs');
const {defaultStateRoot,privateRoot}=require('./private-scratch.cjs');
const {AttemptPermit}=require('./attempt-permit.cjs');
const random=()=>crypto.randomBytes(24).toString('hex');
const fail=(message,statusCode=409)=>Object.assign(Error(message),{statusCode});
function put(root,p,bytes){const dest=path.join(root,p);fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});fs.writeFileSync(dest,bytes,{mode:0o600,flag:'wx'});}
function createPublisher({root,storage,catalog,owner,repo,branch='main',provider=new GitHubProvider({owner,repo,branch}),stateRoot=defaultStateRoot(),controlledAttempts=false}={}){
 let initialized=false,engine,permits;const tickets=new Map(),sessions=new Map(),directRuns=new Set();
 const init=()=>{if(initialized)return;privateRoot(stateRoot);for(const p of ['journals','captures','snapshots','builds'])privateRoot(path.join(stateRoot,p));engine=new Engine(path.join(stateRoot,'journals'));if(controlledAttempts)permits=new AttemptPermit(stateRoot);initialized=true;};
 function local(p){profiles.profile(p);return storage.readLocalFile(p);}
 function localAsset(p){let dir;try{const parent=path.posix.dirname(p);dir=storage.directory(parent==='.'?'':parent);const f=storage.snapshot(`${dir.path}/${path.posix.basename(p)}`);try{return {bytes:Buffer.from(f.bytes),revision:f.sha};}finally{f.close();}}finally{dir?.close();}}
 function sourceValid(t){const current=local(t.path);if(current.sha!==t.revision)throw fail('The saved manuscript revision changed. Reload the saved version before publishing.');for(const [p,s]of Object.entries(t.sources||{})){const f=localAsset(p);if(f.revision!==s.revision||hash(f.bytes)!==s.hash)throw fail('A reviewed dependency changed: '+p);}return current;}
 function createTicket({path:p,sha,ticket=random(),direct=false}){
  init();if(!/^[a-f0-9]{48}$/.test(ticket))throw fail('Invalid review ticket',400);const current=local(p);if(current.sha!==sha)throw fail('The saved revision changed. Reload the saved version before publishing.');if(!catalog().some(d=>d.path===p))throw fail('Entry is absent from the current catalog');
  if(tickets.size>64)for(const [id,t]of tickets)if(t.expires<Date.now()&&!t.busy&&!directRuns.has(t.path))tickets.delete(id);
  if(tickets.size>64)throw fail('Too many publication reviews; close old reviews',429);
  const existing=tickets.get(ticket);if(existing){if(existing.path!==p||existing.revision!==sha||existing.direct!==direct)throw fail('Review identity mismatch');return existing;}
  const parsed=profiles.parse(Buffer.from(current.content),profiles.profile(p));const t={ticket,direct,path:p,revision:sha,title:parsed.data.title,type:profiles.profile(p).type,status:'ready',message:direct?'Validating the saved version…':'Review this explicitly saved version before publishing.',expires:Date.now()+15*60*1000,sourceHash:hash(current.content)};for(const name of fs.readdirSync(engine.journal.root).filter(n=>/^[a-f0-9]{64}$/.test(n))){const op=engine.load(name);if(op.descriptor.plan.manifest.review.path===p&&op.descriptor.plan.request.documentRequest.expectedSourceHash===t.sourceHash&&(op.current.submission==='unknown'||!direct&&op.current.submission==='accepted')){t.operation=name;apply(t,op.current);t.message='Recovered persistent publication status; reconcile if the outcome is uncertain.';}}
  tickets.set(ticket,t);return t;
 }
 async function prepare(t){
  init();if(t.busy)throw fail('Publication preparation is already running');t.busy=true;t.status='validating';t.message='Validating saved revision and remote foundation…';
  try{return await locked(engine.journal.root,'prepare',async()=>{
   const identityPin=controlledAttempts&&provider.controlledAvailable?await provider.verifyIdentity():null;
   const current=sourceValid(t),remote=await provider.snapshot(),raw=readRemote(remote);require('./foundation-lock.cjs').verifyFoundationFiles(raw.files);
   // A prior uncertain transaction must be reconciled before any new publication.
   for(const name of fs.readdirSync(engine.journal.root).filter(n=>/^[a-f0-9]{64}$/.test(n))){const op=engine.load(name);if(op.current.submission==='unknown')throw fail('An interrupted publication needs reconciliation before a new publication. Operation: '+name);}
   const capture=fs.mkdtempSync(path.join(stateRoot,'captures/capture-'));t.capture=capture;t.sources={};
   for(const [p,bytes]of Object.entries(raw.files))if(p==='hugo.toml'||['content/','assets/','layouts/','scripts/','static/','data/'].some(prefix=>p.startsWith(prefix)))put(capture,p,bytes);
   const selected=path.join(capture,t.path);fs.mkdirSync(path.dirname(selected),{recursive:true});fs.writeFileSync(selected,current.content,{mode:0o600});put(capture,'PUBLICATION-CAPTURE.json',Buffer.from('{"publicationCapture":true}\n'));
   const p=profiles.profile(t.path),parsed=profiles.parse(Buffer.from(current.content),p),heroDir=path.posix.dirname(t.path);
   if(p.bundle&&parsed.data.hero===undefined&&['essays','paintings'].includes(p.type)){
    const dir=storage.directory(heroDir);try{for(const name of fs.readdirSync(dir.path).filter(n=>/^hero\./i.test(n))){const rel=heroDir+'/'+name,f=localAsset(rel);fs.writeFileSync(path.join(capture,rel),f.bytes);t.sources[rel]={revision:f.revision,hash:hash(f.bytes)};}}finally{dir.close();}
   }
   let deps=profiles.dependencies(capture,t.path,p,parsed.body,parsed.data);const social=profiles.THEMES[p.type]?`static/images/social/${p.type}/${p.slug}.png`:null;
   for(const rel of deps.filter(n=>n!==social)){
    let f;try{f=localAsset(rel);}catch(error){if(error.code!=='ENOENT')throw fail('Unsafe or unreadable required image: '+rel);if(!raw.files[rel])throw fail('Required local image is missing: '+rel);}
    if(f){const own=rel.startsWith(heroDir+'/')||p.type==='fragments'&&rel.startsWith('static/images/fragments/'+p.slug+'/');if(raw.files[rel]&&!own&&hash(raw.files[rel])!==hash(f.bytes))throw fail('Shared asset differs from remote main: '+rel);fs.mkdirSync(path.dirname(path.join(capture,rel)),{recursive:true});fs.writeFileSync(path.join(capture,rel),f.bytes);t.sources[rel]={revision:f.revision,hash:hash(f.bytes)};}
   }
   const companions=[];
   if(social){
    const spec={type:p.type,selected:t.path,title:parsed.data.title,artist:parsed.data.artist,year:parsed.data.year,date:parsed.data.date,body:parsed.body,output:social,hero:deps.find(n=>n!==social&&!parsed.body.includes(n.split('/').pop())&&(n.includes('/hero.')||n.endsWith(parsed.data.hero||'\0')))};
    if(parsed.data.hero===false)spec.hero=null;else if(typeof parsed.data.hero==='string')spec.hero=profiles.assetPath(t.path,parsed.data.hero);
    const input=path.join(capture,'card-input.json');fs.writeFileSync(input,JSON.stringify(spec),{mode:0o600});
    try{cp.execFileSync(path.join(root,'.venv/bin/python3'),[path.join(__dirname,'render-card.py'),capture,input],{env:{PATH:'/usr/bin:/bin',HOME:capture,LANG:'C.UTF-8',PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:16384});}catch{throw fail('The selected social card could not be prepared privately; no manuscript or original image was changed.');}
    if(['essays','paintings'].includes(p.type)){const companion=`data/lilamaya_social_cards/${p.type}/${p.slug}.json`;const bytes=Buffer.from(JSON.stringify({cardHash:hash(fs.readFileSync(path.join(capture,social)))})+'\n');fs.mkdirSync(path.dirname(path.join(capture,companion)),{recursive:true});fs.writeFileSync(path.join(capture,companion),bytes);companions.push(companion);}
   }
   const expectedAssets=Object.fromEntries(deps.map(n=>{const bytes=read(capture,n);core.internals.imageCheck(bytes,n);return [n,hash(bytes)];}));
   const record=foundation.classify(raw).ledger.documents.find(d=>d.path===t.path);
   const identity=record?.id||'urn:lilamaya:entry:'+crypto.randomUUID();
   const request={desk:true,selected:t.path,expectedRemoteParent:raw.parent,expectedSourceHash:hash(current.content),expectedAssets,overwriteApprovals:Object.fromEntries(deps.filter(n=>raw.files[n]).map(n=>[n,hash(raw.files[n])])),identity,companions,work:path.join(stateRoot,'builds'),target:{owner:provider.owner,repo:provider.repo,branch:provider.branch},committer:{...await provider.actor(),time:Math.floor(Date.now()/1000)}};
   let plan;try{plan=foundation.prepare({localRoot:capture,remote,documentRequest:request});}catch(error){if(error.message==='No publication changes'){t.status='no-changes';t.message='The saved version has no publication changes. No commit was created.';return t;}throw error;}
   const snapshot=path.join(stateRoot,'snapshots',plan.id);fs.mkdirSync(snapshot,{mode:0o700});for(const f of plan.payload)put(snapshot,f.path,Buffer.from(f.bytes,'base64'));
   plan.approvedReview=JSON.parse(JSON.stringify(plan.review));
   const operation=engine.prepare({plan,localRoot:capture,remote,snapshot,directSource:t.direct&&controlledAttempts?{revision:t.revision,assets:t.sources,...(identityPin?{identity:identityPin}:{})}:null});t.operation=operation.operationId;t.plan=plan;if(t.direct)return t;t.confirm=random();t.confirmExpires=Date.now()+5*60*1000;t.status='awaiting-confirmation';t.message=provider.writesEnabled?'Review the exact saved source, assets, publication metadata and remote parent.':'Review is ready. Production writes are disabled pending live-test authorization.';return t;
  });}catch(error){t.status='failed';t.message=error.message;throw error;}finally{t.busy=false;}
 }
 async function confirm(t,token){
  if(controlledAttempts)throw fail('Publication permit is only valid for direct Publish',403);
  if(t.busy||t.status!=='awaiting-confirmation'||token!==t.confirm||t.confirmExpires<Date.now())throw fail('Confirmation is stale, expired or already used');
  return submit(t);
 }
 async function submit(t){
  sourceValid(t);if(canonical(t.plan.manifest.target)!==canonical({owner:provider.owner,repo:provider.repo,branch:provider.branch}))throw fail('Publication target changed after validation');t.confirm=null;t.busy=true;t.status='submitting';t.message='Submitting the saved version…';
  try{const state=await engine.submit(t.operation,{remote:provider,afterValidation:()=>sourceValid(t),controlled:controlledAttempts?{direct:t.direct,permits}:null});apply(t,state);return t;}finally{t.busy=false;}
 }
 async function prepareDirect(path,sha){
  if(!controlledAttempts||!provider.controlledAvailable)throw fail('Controlled publication is not configured',403);
  const t=createTicket({path,sha,direct:true});
  if(t.operation)throw fail('Reconcile the earlier publication before preparing a new attempt');
  await prepare(t);
  if(t.operation){
   t.status='writes-disabled';t.message='Saved transaction prepared. A local operator permit is required.';
  }
  return publicState(t);
 }
 async function publish(input){
  if(directRuns.has(input.path))throw fail('Publication is already in progress for this entry');
  const t=createTicket({...input,direct:true});
  if(t.started)return t;
  t.started=true;
  directRuns.add(t.path);
  try{
   if(t.status==='unknown'){
    t.busy=true;
    recover(engine.journal.root);
    apply(t,await engine.reconcile(t.operation,{remote:provider}));
   }else if(!t.operation){
    const permit=permits?.read();
    if(permit){
     const operation=engine.load(permit.binding.operationId),source=operation.descriptor.directSource;
     if(!source||t.path!==permit.binding.path||t.revision!==source.revision)throw fail('Publication permit does not match this saved entry');
     t.operation=operation.tx.operationId;
     if(operation.current.submission==='accepted'){
      apply(t,operation.current);
      return t;
     }
     permits.check(operation);
     t.plan=operation.descriptor.plan;
     t.sources=source.assets;
    }else await prepare(t);
    if(t.operation){
     if(controlledAttempts&&!permit){
      t.status='writes-disabled';t.message='Saved transaction prepared. A local operator permit is required.';
     }else await submit(t);
    }
   }
  }catch(error){
   const state=t.operation&&engine.load(t.operation).current;
   if(state&&['accepted','unknown'].includes(state.submission))apply(t,state);
   else{t.status='failed';t.message=error.message;}
  }finally{t.busy=false;directRuns.delete(t.path);}
  return t;
 }
 function apply(t,state){t.engineState=state;t.status=state.status==='PRODUCTION_WRITES_DISABLED'?'writes-disabled':state.submission==='unknown'?'unknown':state.submission==='rejected'?'rejected':state.status==='LIVE_VERIFIED'?'live':state.submission==='accepted'?(state.state||'submitted'):(t.direct?'failed':'ready');t.message=state.message||state.reason||state.status;if(state.liveURL)t.liveURL=state.liveURL;t.commit=state.commit;}
 async function status(t){if(t.operation&&!t.busy){const op=engine.load(t.operation);if(op.current.submission==='accepted'&&!['live','failed','cancelled','timed_out','superseded'].includes(t.status)){const state=await engine.pollDeployment(t.operation,{remote:provider});apply(t,state);}}return t;}
 function publicState(t){return {ticket:t.ticket,path:t.path,revision:t.revision,status:t.status,message:t.message,title:t.title,type:t.type,commit:t.commit,operation:t.operation,liveURL:t.status==='live'?t.liveURL:null,productionWritesEnabled:provider.writesEnabled};}
 function tokenSession(req){const id=(req.headers.cookie||'').match(/(?:^|; )lilamaya_publish=([a-f0-9]{48})(?:;|$)/)?.[1],s=sessions.get(id);if(!s||s.expires<Date.now())throw fail('Publication session expired; open a fresh review',403);return s;}
 function host(req){if(!['127.0.0.1:1314','localhost:1314'].includes(req.headers.host))throw fail('Invalid publication Host',403);}
 function secure(res){res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");res.setHeader('X-Frame-Options','DENY');res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.setHeader('X-Content-Type-Options','nosniff');}
 function json(res,code,value){res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}
 async function body(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>16384)throw fail('Request too large',413);}return JSON.parse(text);}
 async function handle(req,res){
  const url=new URL(req.url,'http://127.0.0.1:1314');if(!url.pathname.startsWith('/publishing/'))return false;
  try{
   host(req);secure(res);
   if(req.method==='OPTIONS'){if(url.pathname!=='/publishing/status'||req.headers.origin!=='http://localhost:1313')throw fail('Cross-origin publication authorization is forbidden',403);res.setHeader('Access-Control-Allow-Origin','http://localhost:1313');res.writeHead(204);res.end();return true;}
   if(url.pathname==='/publishing/status'&&req.method==='GET'){
    if(req.headers.origin&&req.headers.origin!=='http://localhost:1313'&&req.headers.origin!=='http://'+req.headers.host)throw fail('Invalid status Origin',403);res.setHeader('Access-Control-Allow-Origin','http://localhost:1313');const t=tickets.get(url.searchParams.get('ticket'));if(!t)throw fail('No publication review was found',404);json(res,200,publicState(await status(t)));return true;
   }
   if(url.pathname==='/publishing/review'&&req.method==='GET'){
    const t=createTicket({path:url.searchParams.get('path'),sha:url.searchParams.get('sha'),ticket:url.searchParams.get('ticket')});const id=random(),nonce=random();sessions.set(id,{ticket:t.ticket,nonce,expires:Date.now()+30*60*1000});res.setHeader('Set-Cookie','lilamaya_publish='+id+'; HttpOnly; SameSite=Strict; Path=/publishing');res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(fs.readFileSync(path.join(__dirname,'review.html')));return true;
   }
   if(['/publishing/review.js','/publishing/review.css'].includes(url.pathname)&&req.method==='GET'){res.writeHead(200,{'Content-Type':url.pathname.endsWith('.js')?'text/javascript':'text/css'});res.end(fs.readFileSync(path.join(__dirname,path.basename(url.pathname))));return true;}
   // Only the private Writing Desk origin can mint and use this session.
   if(url.pathname==='/publishing/desk-session'&&req.method==='GET'){
    if(req.headers['sec-fetch-site']!=='same-origin'||req.headers['x-writing-desk']!=='publish')throw fail('Publication session requires the private Writing Desk origin',403);
    for(const [id,session]of sessions)if(session.expires<Date.now())sessions.delete(id);
    const id=random(),nonce=random();
    sessions.set(id,{direct:true,nonce,expires:Date.now()+5*60*1000});
    res.setHeader('Set-Cookie','lilamaya_desk_publish='+id+'; HttpOnly; SameSite=Strict; Path=/publishing');
    json(res,200,{csrf:nonce});return true;
   }
   if(url.pathname==='/publishing/publish'){
    if(req.method!=='POST'||req.headers.origin!=='http://'+req.headers.host||req.headers['sec-fetch-site']!=='same-origin'||!/^application\/json(?:;|$)/.test(req.headers['content-type']||''))throw fail('Publication requires the private Writing Desk origin',403);
    const id=(req.headers.cookie||'').match(/(?:^|; )lilamaya_desk_publish=([a-f0-9]{48})(?:;|$)/)?.[1],session=sessions.get(id);
    const input=await body(req);
    if(!session?.direct||session.expires<Date.now()||input.csrf!==session.nonce||!sessions.delete(id))throw fail('Publication authorization failed',403);
    if(typeof input.path!=='string'||!/^LOCAL:[a-f0-9]{64}$/.test(input.sha)||!/^[a-f0-9]{48}$/.test(input.ticket))throw fail('A saved path and revision are required',400);
    json(res,200,publicState(await publish({path:input.path,sha:input.sha,ticket:input.ticket})));return true;
   }
   const session=tokenSession(req),t=tickets.get(session.ticket);if(!t)throw fail('Review expired',403);
   if(url.pathname==='/publishing/session'&&req.method==='GET'){json(res,200,{...publicState(t),csrf:session.nonce});return true;}
   if(req.method!=='POST'||req.headers.origin!=='http://'+req.headers.host||!/^application\/json(?:;|$)/.test(req.headers['content-type']||''))throw fail('Privileged publication requests require their private API origin',403);
   const input=await body(req);if(input.csrf!==session.nonce)throw fail('Publication authorization failed',403);
   if(url.pathname==='/publishing/prepare')await prepare(t);
   else if(url.pathname==='/publishing/confirm')await confirm(t,input.confirmation);
   else if(url.pathname==='/publishing/cancel'){if(t.busy)throw fail('An operation is in progress');t.status='cancelled';t.confirm=null;t.message='Publication cancelled. The local manuscript is unchanged.';}
   else if(url.pathname==='/publishing/recover'){init();recover(engine.journal.root);if(!t.operation&&input.operation)t.operation=input.operation;if(engine.load(t.operation).descriptor.plan.manifest.review.path!==t.path)throw fail('Recovery operation belongs to another entry');const state=await engine.reconcile(t.operation,{remote:provider});apply(t,state);}
   else throw fail('Unknown publication operation',404);
   json(res,200,{...publicState(t),review:t.plan?.review,confirmation:t.confirm,confirmationExpires:t.confirmExpires});
  }catch(error){json(res,error.statusCode||409,{error:error.message});}
  return true;
 }
 return {handle,prepare,prepareDirect,confirm,status,createTicket,publicState,provider};
}
module.exports={createPublisher};
