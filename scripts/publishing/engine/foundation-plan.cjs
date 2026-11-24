'use strict';
const fs=require('node:fs'),path=require('node:path');
const {hash,internals:{canonical}}=require('./editor-publish.cjs');
const {preparePublication,approvePublication,verifyPublication}=require('./publication-policy.cjs');
const {inventory,proposedInventory,LEDGER}=require('./remote-inventory.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
const equal=(a,b)=>canonical(a)===canonical(b);
const fail=m=>{throw new Error(m);};
function projectFiles(before,publication){
 const files=Object.fromEntries(Object.entries(before.files).map(([p,b])=>[p,Buffer.from(b)]));
 const selectedId=publication.manifest.id,selected=publication.manifest.selected,allowedOwner=new Set([selectedId,'draft:'+selected]);
 for(const f of publication.files){
  const b=Buffer.from(f.bytes,'base64');if(hash(b)!==f.hash)fail('Tampered publication payload');
  if(f.path!==selected&&before.files[f.path]&&hash(before.files[f.path])!==f.hash){
   const asset=before.manifest.assets.find(a=>a.path===f.path);
   if(!asset||!asset.owners.some(o=>allowedOwner.has(o))||asset.owners.some(o=>!allowedOwner.has(o)))fail('Unrelated/shared asset overwrite prohibited');
  }
  files[f.path]=b;
 }
 for(const f of publication.manifest.removals){
  const asset=before.manifest.assets.find(a=>a.path===f.path);
  if(!asset||asset.hash!==f.hash||!asset.owners.some(o=>allowedOwner.has(o))||asset.owners.some(o=>!allowedOwner.has(o)))fail('Unrelated/shared asset removal prohibited');
  delete files[f.path];
 }
 const ledger=clone(before.ledger),index=ledger.documents.findIndex(d=>d.id===selectedId);
 if(index<0)ledger.documents.push(publication.manifest.nextIdentity);else ledger.documents[index]=publication.manifest.nextIdentity;
 files[LEDGER]=Buffer.from(canonical(ledger)+'\n');return files;
}
function prepareFoundation({localRoot,remote,expectedFoundationId,documentRequest}){
 if(documentRequest.desk)return require('../desk-foundation.cjs').prepare({localRoot,remote,expectedFoundationId,documentRequest});
 if(remote.ref?.oid!==documentRequest.expectedRemoteParent)fail('Remote parent changed');
 const before=inventory(remote);if(before.manifest.id!==expectedFoundationId)fail('Publication foundation changed');
 const selected=documentRequest.selected,original=before.manifest.documents.find(d=>d.path===selected);
 const currentRemote={...before.policyRemote,entries:{...before.policyRemote.entries}};
 // Explicitly absent destinations are required by the existing shared builder.
 if(!Object.hasOwn(currentRemote.entries,selected))currentRemote.entries[selected]=null;
 for(const p of Object.keys(documentRequest.expectedAssets||{}))if(!Object.hasOwn(currentRemote.entries,p))currentRemote.entries[p]=null;
 const publication=preparePublication({...documentRequest,root:localRoot,remote:currentRemote});
 const nextFiles=projectFiles(before,publication),post=proposedInventory(nextFiles,before.manifest);
 const written=[...publication.files.map(f=>f.path),LEDGER],removed=publication.manifest.removals.map(f=>f.path);
 const touched=new Set([...written,...removed]);
 for(const [p,b] of Object.entries(before.files))if(!touched.has(p)&&(!nextFiles[p]||!nextFiles[p].equals(b)))fail('Unrelated remote content changed');
 for(const d of before.manifest.documents.filter(d=>d.status==='published'&&d.path!==selected)){
  const n=post.manifest.documents.find(x=>x.id===d.id);if(!n||!equal(d,n))fail('Another published document changed');
 }
 for(const d of before.manifest.documents.filter(d=>d.status==='draft'&&d.path!==selected)){
  const n=post.manifest.documents.find(x=>x.path===d.path);if(!n||!equal(d,n))fail('Another draft changed or became published');
 }
 for(const [p,url] of Object.entries(before.manifest.authoritative.pages))if(p!==selected&&post.manifest.authoritative.pages[p]!==url)fail('Another manuscript permalink changed');
 const changes=[...new Set([...written,...removed])].sort().map(p=>({path:p,action:!nextFiles[p]?'remove':!before.files[p]?'add':hash(before.files[p])===hash(nextFiles[p])?'reuse':'update',before:before.files[p]?hash(before.files[p]):null,after:nextFiles[p]?hash(nextFiles[p]):null}));
 const review={publication:publication.review,files:changes,ledger:{path:LEDGER,before:before.manifest.ledgerHash,after:hash(nextFiles[LEDGER]),selectedId:publication.manifest.id},destinationState:original?.status||'absent'};
 const manifest={version:4,syntheticOnly:true,expectedRemoteParent:before.manifest.parent,foundationId:before.manifest.id,foundationTree:before.manifest.tree,
 identity:publication.manifest.nextIdentity,existingPublishedVersion:original?.status==='published'?original.hash:null,existingDraftVersion:original?.status==='draft'?original.hash:null,
 sourcePaths:publication.manifest.files,permalink:publication.manifest.permalink,exactChanges:changes,expectedPostInventory:post.manifest,review};
 const payload=written.map(p=>({path:p,hash:hash(nextFiles[p]),bytes:nextFiles[p].toString('base64')}));
 return clone({id:hash(canonical(manifest)),manifest,review,payload,publication,request:{expectedFoundationId,documentRequest}});
}
function approveFoundation(plan,review){if(!equal(plan.review,review))fail('Exact foundation review approval required');return {...clone(plan),approvedReview:clone(review)};}
function verifyFoundation(plan,{localRoot,remote}){
 if(plan.manifest.desk)return require('../desk-foundation.cjs').verify(plan,{localRoot,remote});
 if(!plan.approvedReview||!equal(plan.review,plan.approvedReview))fail('Foundation approval missing or changed');
 const fresh=prepareFoundation({...plan.request,localRoot,remote}),plain=clone(plan);delete plain.approvedReview;
 if(!equal(plain,fresh))fail('Tampered publication plan or post-inventory');return true;
}
function materializeFoundation(plan,{localRoot,remote,output}){
 verifyFoundation(plan,{localRoot,remote});if(!path.isAbsolute(output)||output===localRoot||output.startsWith(localRoot+'/'))fail('Separate snapshot output required');
 let current=path.parse(output).root;for(const part of path.dirname(output).slice(current.length).split('/').filter(Boolean)){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())fail('Unsafe snapshot ancestor');}
 fs.mkdirSync(output,{mode:0o700});for(const f of plan.payload){const dest=path.join(output,f.path);fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});fs.writeFileSync(dest,Buffer.from(f.bytes,'base64'),{flag:'wx',mode:0o600});}
 return plan.payload.map(x=>x.path).sort();
}
// Inspection-only mock projection, not a commit/branch adapter.
function inspectProposed(plan,{localRoot,remote}){verifyFoundation(plan,{localRoot,remote});const before=inventory(remote);return proposedInventory(projectFiles(before,plan.publication),before.manifest);}
module.exports={prepareFoundation,approveFoundation,verifyFoundation,materializeFoundation,inspectProposed};
