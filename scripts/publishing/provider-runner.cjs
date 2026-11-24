'use strict';
const {locked}=require('./process-lock.cjs');
const {verifyFoundation}=require('./engine/foundation-plan.cjs');
async function reconcile(engine,id,provider){
 const op=engine.load(id);if(op.current.submission==='rejected')return op.current;
 try{const head=await provider.head(),commit=await provider.contains(head,op.tx.commit);
  if(commit){if(commit.tree.sha!==op.tx.tree)throw Error('Accepted commit tree differs');engine.journal.append(id,'ACCEPTED',{status:'GITHUB_ACCEPTED',reason:'Provider independently verified exact intended commit and ancestry',observedHead:head});return engine.load(id).current;}
  if(op.current.submission==='not-submitted'&&head!==op.tx.parent){engine.journal.append(id,'REJECTED',{reason:'Remote parent changed before submission'});return engine.load(id).current;}
 }catch{}
 if(op.current.submission==='not-submitted')return op.current;
 if(['unknown','not-submitted'].includes(op.current.submission))engine.journal.append(id,'UNKNOWN',{reason:'Submission outcome cannot be proven; no retry was made'});
 return {...engine.load(id).current,needsReview:true};
}
async function submit(engine,id,provider,revalidate,controlled){return locked(engine.journal.root,id,async()=>{
 const op=engine.load(id);if(op.current.submission==='accepted'||op.current.submission==='rejected')return op.current;
 if(op.current.submission==='unknown')return reconcile(engine,id,provider);
 if(!provider.writesEnabled&&!(controlled&&provider.controlledAvailable))return {...op.current,status:'PRODUCTION_WRITES_DISABLED',reason:'Production publication is disabled pending explicit authorization.'};
 if(controlled){
  if(!controlled.direct||!op.descriptor.directSource)throw Error('Publication permit is only valid for direct Publish');
  controlled.permits.check(op);
  await provider.verifyIdentity(op.descriptor.directSource.identity);
 }
 try{const remote=await provider.snapshot(op.tx.parent);verifyFoundation(op.descriptor.plan,{localRoot:op.descriptor.localRoot,remote});require('./engine/transaction-engine.cjs').snapshotBytes(op.descriptor.plan,op.descriptor.snapshot);if(revalidate)await revalidate();}
 catch(error){engine.journal.append(id,'REJECTED',{reason:'Pre-submission validation failed: '+error.message});return engine.load(id).current;}
 const grant=controlled?.permits.consume(op);
 engine.journal.append(id,'ATTEMPT_STARTED',grant?{permitId:grant.id}:{});

 try{await provider.publish(op.tx,grant,engine.journal);}catch(error){engine.journal.append(id,'UNKNOWN',{reason:'Submission acknowledgement was unavailable; reconciliation is required'});}
 return reconcile(engine,id,provider);
 });}
async function deployment(engine,id,provider){const op=engine.load(id);if(op.current.submission!=='accepted')return op.current;let evidence;try{evidence=await provider.deployment(op.tx);}catch{evidence={state:'unverified',message:'Deployment evidence could not be read.'};}
 const statuses={submitted:'GITHUB_ACCEPTED',deploying:'DEPLOYMENT_PENDING',live:'LIVE_VERIFIED',failed:'DEPLOYMENT_FAILED',cancelled:'DEPLOYMENT_CANCELLED',timed_out:'DEPLOYMENT_TIMED_OUT',superseded:'DEPLOYMENT_SUPERSEDED',unverified:'DEPLOYMENT_UNVERIFIED'};
 engine.journal.append(id,'DEPLOYMENT',{deployment:evidence.state,status:statuses[evidence.state]||'DEPLOYMENT_UNVERIFIED',...evidence});return engine.load(id).current;}
module.exports={submit,reconcile,deployment};
