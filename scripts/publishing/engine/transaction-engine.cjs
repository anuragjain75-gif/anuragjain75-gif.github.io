'use strict';
const fs=require('node:fs'),path=require('node:path');
const {hash,internals:{canonical,read}}=require('./editor-publish.cjs');
const {readRemote,buildTree,oid}=require('./mock-git.cjs');
const {verifyFoundation}=require('./foundation-plan.cjs');
const {MockRemote,operationId,publicationCommit,sealTx,verifyTx,ancestor}=require('./mock-remote.cjs');
const {Journal}=require('./operation-journal.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
const equal=(a,b)=>canonical(a)===canonical(b);
function state(submission,extra={}){return {submission,deployment:'not-observed',status:submission==='not-submitted'?'DEFINITELY_NOT_SUBMITTED':submission==='rejected'?'DEFINITELY_REJECTED':submission==='accepted'?'ACCEPTED_BY_MOCK_REMOTE':'OUTCOME_UNKNOWN',needsReview:submission==='unknown',...extra};}
function snapshotBytes(plan,root){if(!path.isAbsolute(root))throw new Error('Absolute snapshot required');let at=path.parse(root).root;for(const part of root.slice(at.length).split('/').filter(Boolean)){at=path.join(at,part);if(fs.lstatSync(at).isSymbolicLink())throw new Error('Unsafe snapshot ancestor');}
 const names=[];function walk(dir,p=''){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.isSymbolicLink())throw new Error('Unsafe snapshot symlink');if(e.isDirectory())walk(path.join(dir,e.name),p+e.name+'/');else if(e.isFile())names.push(p+e.name);else throw new Error('Unsafe snapshot entry');}}walk(root);
 if(!equal(names.sort(),plan.payload.map(p=>p.path).sort()))throw new Error('Snapshot exact-file inventory mismatch');const bytes={};for(const f of plan.payload){const b=read(root,f.path);if(hash(b)!==f.hash||b.toString('base64')!==f.bytes)throw new Error('Snapshot bytes changed');bytes[f.path]=b;}return bytes;
}
function transaction(plan,remote,snapshot){
 const raw=readRemote(remote),files=Object.fromEntries(Object.entries(raw.files).map(([p,b])=>[p,Buffer.from(b)]));for(const [p,b]of Object.entries(snapshot))files[p]=b;
 for(const change of plan.manifest.exactChanges)if(change.action==='remove')delete files[change.path];
 const hashes=Object.fromEntries(Object.entries(files).sort().map(([p,b])=>[p,hash(b)]));if(!equal(hashes,plan.manifest.expectedPostInventory.fileHashes))throw new Error('Transaction would change unapproved files');
 const built=buildTree(Object.fromEntries(Object.entries(files).map(([p,b])=>[p,{bytes:b,mode:raw.modes[p]||'100644'}])));if(built.tree!==plan.manifest.expectedPostInventory.tree)throw new Error('Expected post-tree mismatch');
 const t={version:5,planId:plan.id,foundationId:plan.manifest.foundationId,parent:raw.parent,tree:built.tree};if(plan.manifest.desk){t.committer=clone(plan.manifest.committer);t.target=clone(plan.manifest.target);t.message='Publish '+plan.manifest.review.type+': '+plan.manifest.review.title;}t.operationId=operationId(t);const b=publicationCommit(t);t.commit=oid('commit',b);t.objects=Object.fromEntries(Object.entries(built.objects).filter(([id])=>!Object.hasOwn(remote.objects,id)));t.objects[t.commit]={type:'commit',data:b.toString('base64')};
 t.expectedPage={url:plan.manifest.permalink,publicationHash:plan.manifest.identity.sourceHash,artifactHash:hash(canonical({commit:t.commit,url:plan.manifest.permalink,source:plan.manifest.identity.sourceHash,kind:'MOCK-RENDERED-ARTIFACT'}))};
 if(plan.manifest.desk){t.expectedLive=clone(plan.manifest.proof);delete t.expectedPage;}
 t.files=clone(plan.manifest.exactChanges);t.digest=sealTx(t).digest;verifyTx(t);return t;
}
function receiptValid(receipt,tx){return receipt&&receipt.operationId===tx.operationId&&receipt.digest===tx.digest&&receipt.expected===tx.parent&&receipt.commit===tx.commit&&['accepted','rejected'].includes(receipt.status)&&/^[a-f0-9]{40}$/.test(receipt.observed)&&(receipt.status==='accepted'?(receipt.tree===tx.tree&&receipt.observed===tx.commit):receipt.observed!==tx.parent);}
class SimulatedInterruption extends Error{}
class Engine {
 constructor(root){this.journal=new Journal(root);}
 load(id){const j=this.journal.read(id);verifyTx(j.prepared.tx);let current=null;for(let i=0;i<j.records.length;i++){const e=j.records[i];if(i===0&&e.type!=='PREPARED')throw new Error('Invalid initial journal state');const allowed=['PREPARED','BEFORE_SEND_FAILURE','ATTEMPT_STARTED','REJECTED','ACCEPTED','UNKNOWN','DEPLOYMENT'];if(!allowed.includes(e.type))throw new Error('Unknown journal transition');
   if(e.type==='PREPARED'){if(i!==0)throw new Error('Duplicate prepare transition');current=state('not-submitted');}
   else if(e.type==='ATTEMPT_STARTED'){if(current.submission!=='not-submitted')throw new Error('Invalid attempt transition');current=state('unknown',{reason:'Attempt started; acknowledgement not recorded'});}
   else if(e.type==='BEFORE_SEND_FAILURE'){if(current.submission!=='not-submitted')throw new Error('Unsafe retry transition');current=state('not-submitted',e.data);}
   else if(e.type==='REJECTED'){if(current.submission==='accepted')throw new Error('Contradictory rejection');current=state('rejected',e.data);}
   else if(e.type==='ACCEPTED'){if(current.submission==='rejected')throw new Error('Contradictory acceptance');current=current.submission==='accepted'?{...current,...e.data}:state('accepted',e.data);}
   else if(e.type==='UNKNOWN'){if(!['unknown','not-submitted'].includes(current.submission))throw new Error('Invalid unknown transition');current=state('unknown',e.data);}
   else if(e.type==='DEPLOYMENT'){if(current.submission!=='accepted')throw new Error('Deployment before acceptance');current={...current,...e.data};}
  }
  return {...j,tx:j.prepared.tx,descriptor:j.prepared.descriptor,current:{...current,operationId:id,commit:j.prepared.tx.commit}};
 }
 prepare({plan,localRoot,remote,snapshot,directSource}){verifyFoundation(plan,{localRoot,remote});const bytes=snapshotBytes(plan,snapshot),tx=transaction(plan,remote,bytes);this.journal.create(tx,{plan:clone(plan),localRoot,snapshot,approvedReviewHash:hash(canonical(plan.approvedReview)),identity:plan.manifest.identity,...(directSource?{directSource}:{})});return this.load(tx.operationId).current;}
 async submit(id,{remote,fault='none',afterValidation=null,controlled=null}={}){
  if(require('../github-provider.cjs').isProvider(remote))return require('../provider-runner.cjs').submit(this,id,remote,afterValidation,controlled);
  if(!(remote instanceof MockRemote))throw new Error('Only the offline MockRemote is supported');
  return this.journal.withOperation(id,async()=>{let op=this.load(id);if(op.current.submission==='accepted'||op.current.submission==='rejected')return op.current;if(op.current.submission==='unknown')throw new Error('Reconcile uncertain operation before any retry');
   let observed;try{observed=remote.observe(id);}catch(error){this.journal.append(id,'BEFORE_SEND_FAILURE',{reason:error.message});return this.load(id).current;}
   // Another journal/process may already have submitted this same deterministic operation.
   // Recognize independent exact-result evidence before treating its advanced tip as a conflict.
   try{if(observed.receipt||ancestor(observed.remote.objects,observed.remote.ref.oid,op.tx.commit))return this.reconcile(id,{remote});}
   catch(error){this.journal.append(id,'UNKNOWN',{reason:'Independent prior-operation evidence incomplete; explicit review required'});return this.load(id).current;}
   try{verifyFoundation(op.descriptor.plan,{localRoot:op.descriptor.localRoot,remote:observed.remote});snapshotBytes(op.descriptor.plan,op.descriptor.snapshot);}catch(error){this.journal.append(id,'REJECTED',{reason:'Preflight rejected: '+error.message});return this.load(id).current;}
   if(fault==='before-send'){this.journal.append(id,'BEFORE_SEND_FAILURE',{reason:'Transport failed before handing off request'});return this.load(id).current;}
   this.journal.append(id,'ATTEMPT_STARTED',{});
   if(afterValidation)await afterValidation();
   if(fault==='crash-before-update')throw new SimulatedInterruption('Interrupted after durable attempt marker, before update');
   if(fault==='during-not-applied'){this.journal.append(id,'UNKNOWN',{reason:'Connection ended during handoff; outcome unconfirmed'});return this.load(id).current;}
   let receipt;try{receipt=remote.compareAndSwap(op.tx);}catch(error){this.journal.append(id,'UNKNOWN',{reason:'Remote operation outcome unconfirmed: '+error.message});return this.load(id).current;}
   if(fault==='crash-after-update')throw new SimulatedInterruption('Interrupted after remote operation, before journal acknowledgement');
   if(fault==='lost-ack'||fault==='during-applied'){this.journal.append(id,'UNKNOWN',{reason:'Acknowledgement unavailable'});return this.load(id).current;}
   if(!receiptValid(receipt,op.tx)){this.journal.append(id,'UNKNOWN',{reason:'Unreliable acknowledgement'});return this.load(id).current;}
   this.journal.append(id,receipt.status==='accepted'?'ACCEPTED':'REJECTED',{reason:receipt.status==='accepted'?'Conditional update acknowledged':'Conditional update rejected',receipt});return this.load(id).current;
  });
 }
 reconcile(id,{remote}){
  if(require('../github-provider.cjs').isProvider(remote))return require('../provider-runner.cjs').reconcile(this,id,remote);
  if(!(remote instanceof MockRemote))throw new Error('Only the offline MockRemote is supported');let op;try{op=this.load(id);}catch(error){return state('unknown',{operationId:id,needsReview:true,reason:'Recovery journal invalid: '+error.message});}
  if(op.current.submission==='rejected')return op.current;
  let observed;try{observed=remote.observe(id);readRemote(observed.remote);}catch(error){if(['unknown','not-submitted'].includes(op.current.submission))this.journal.append(id,'UNKNOWN',{reason:'Independent observation unavailable'});return {...this.load(id).current,needsReview:true};}
  const receipt=observed.receipt;if(receipt&&!receiptValid(receipt,op.tx)){if(['unknown','not-submitted'].includes(op.current.submission))this.journal.append(id,'UNKNOWN',{reason:'Ambiguous remote receipt; explicit review required'});return {...this.load(id).current,needsReview:true};}
  let reachable=false;try{reachable=ancestor(observed.remote.objects,observed.remote.ref.oid,op.tx.commit);}catch(error){if(['unknown','not-submitted'].includes(op.current.submission))this.journal.append(id,'UNKNOWN',{reason:'Incomplete ancestry proof; explicit review required'});return {...this.load(id).current,needsReview:true};}
  if(reachable){if(receipt?.status==='rejected'){if(['unknown','not-submitted'].includes(op.current.submission))this.journal.append(id,'UNKNOWN',{reason:'Contradictory history and receipt'});return {...this.load(id).current,needsReview:true};}this.journal.append(id,'ACCEPTED',{reason:'Independently observed exact intended commit in current ancestry',observedHead:observed.remote.ref.oid,branchAdvanced:observed.remote.ref.oid!==op.tx.commit,needsReview:false});return this.load(id).current;}
  if(receipt?.status==='rejected'&&op.current.submission!=='accepted'){this.journal.append(id,'REJECTED',{reason:'Independent operation receipt confirms rejection',receipt});return this.load(id).current;}
  if(['unknown','not-submitted'].includes(op.current.submission))this.journal.append(id,'UNKNOWN',{reason:'Intended update not proven; absence or unrelated branch movement does not establish outcome',needsReview:true});return {...this.load(id).current,needsReview:['unknown','not-submitted'].includes(op.current.submission)};
 }
 pollDeployment(id,{remote}){
  if(require('../github-provider.cjs').isProvider(remote))return require('../provider-runner.cjs').deployment(this,id,remote);
  if(!(remote instanceof MockRemote))throw new Error('Only the offline MockRemote is supported');const op=this.load(id);if(op.current.submission!=='accepted')throw new Error('Submission not established');if(op.current.status==='DEPLOYMENT_VERIFIED')return op.current;
  let job;try{job=remote.observeDeployment(op.tx.commit);}catch{job={status:'unknown'};}
  let data={deployment:'unknown',status:'ACCEPTED_BY_MOCK_REMOTE',needsReview:false,reason:'Deployment not independently verified'};
  if(job.commit===op.tx.commit&&job.tree===op.tx.tree){
   if(['queued','running'].includes(job.status))data={deployment:job.status,status:'DEPLOYMENT_PENDING',needsReview:false};
   else if(job.status==='failed')data={deployment:'failed',status:'DEPLOYMENT_FAILED',needsReview:false};
   else if(job.status==='success'){
    const expected={...op.tx.expectedPage,commit:op.tx.commit};data=equal(job.page,expected)?{deployment:'successful',status:'DEPLOYMENT_VERIFIED',needsReview:false}:{deployment:'unknown',status:'ACCEPTED_BY_MOCK_REMOTE',needsReview:true,reason:'Completed job lacks matching intended page/artifact proof'};
   }
  }
  this.journal.append(id,'DEPLOYMENT',data);return this.load(id).current;
 }
}
module.exports={Engine,SimulatedInterruption,snapshotBytes,transaction};
