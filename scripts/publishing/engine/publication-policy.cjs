'use strict';
// One publication engine: this policy layer binds makePlan's shared snapshot builder
// to an explicit mock published-state ledger and exact reviewed changes.
const fs=require('node:fs');
const core=require('./editor-publish.cjs');
const {catalog,localUrl}=require('./hugo-authority.cjs');
const {hash}=core, {canonical,profile,parse,safePath}=core.internals;
const fail=m=>{throw new Error(m);};
const sha=h=>typeof h==='string' && /^[a-f0-9]{64}$/.test(h);
const clone=x=>JSON.parse(JSON.stringify(x));
const equal=(a,b)=>canonical(a)===canonical(b);
function validIdentity(id) {if(typeof id!=='string'||!/^urn:lilamaya:synthetic:[a-z0-9-]+$/.test(id))fail('Explicit synthetic document identity required');}
function localPermalink(u) { return localUrl(u); }
function remoteBytes(remote,p) {
 safePath(p);
 if(!Object.hasOwn(remote.files,p)||typeof remote.files[p]!=='string')fail('Published bytes missing');
 const b=Buffer.from(remote.files[p],'base64');
 if(b.toString('base64')!==remote.files[p]||hash(b)!==remote.entries[p])fail('Changed published content or asset');
 return b;
}
function validateLedger(remote) {
 if(!remote||!Array.isArray(remote.documents)||!remote.files)fail('Synthetic published ledger required');
 const ids=new Set(),paths=new Set(),urls=new Set();
 for(const d of remote.documents) {
  validIdentity(d.id);safePath(d.path);localPermalink(d.permalink);
  if(ids.has(d.id)||paths.has(d.path)||urls.has(d.permalink))fail('Duplicate or ambiguous identity');
  ids.add(d.id);paths.add(d.path);urls.add(d.permalink);
  const p=profile(d.path);
  if(p.type!==d.type||!sha(d.sourceHash)||!d.assets||Array.isArray(d.assets))fail('Invalid identity record');
  if(remote.entries[d.path]!==d.sourceHash)fail('Stale published version');
  for(const [a,h] of Object.entries(d.assets)){safePath(a);if(!sha(h)||remote.entries[a]!==h)fail('Stale published asset');}
 }
 for(const [path,digest] of Object.entries(remote.entries||{})) {
  if(digest!==null&&/^content\/(essays|fragments|paintings)\/.+\.md$/.test(path)&&!paths.has(path)){const draft=remote.unpublished?.[path];if(!draft||draft.sourceHash!==digest)fail('Incomplete or ambiguous publication inventory');parse(remoteBytes(remote,path),profile(path),'publish-new');}
 }
}
function themeValidation(data) {
 for(const k of ['themes','fragmentthemes','paintingthemes'])if(data[k]) {
  if(data[k].length>50||data[k].some(x=>x!==x.trim()||x.length>100)||new Set(data[k]).size!==data[k].length)fail('Ambiguous theme assignment');
 }
}
function deltaMetadata(before,after) {
 return [...new Set([...Object.keys(before),...Object.keys(after)])].sort().filter(k=>!equal(before[k],after[k]))
 .map(field=>({field,before:Object.hasOwn(before,field)?before[field]:null,after:Object.hasOwn(after,field)?after[field]:null}));
}
function assetDelta(previous,files) {
 const next=Object.fromEntries(files.map(f=>[f.path,f.hash]));
 return {
  add:Object.keys(next).filter(p=>!Object.hasOwn(previous,p)).sort().map(path=>({path,hash:next[path]})),
  replace:Object.keys(next).filter(p=>Object.hasOwn(previous,p)&&previous[p]!==next[p]).sort().map(path=>({path,before:previous[path],after:next[path]})),
  remove:Object.keys(previous).filter(p=>!Object.hasOwn(next,p)).sort().map(path=>({path,hash:previous[path]}))
 };
}
function preparePublication(input) {
 const {root,remote,operation,id,expectedRemoteParent,expectedPublishedHash=null,permalink,allowDateChange=false,allowPermalinkChange=false}=input;
 validIdentity(id);validateLedger(remote);
 if(!['publish-new','publish-changes'].includes(operation))fail('Explicit publication operation required');
 if(typeof allowDateChange!=='boolean'||typeof allowPermalinkChange!=='boolean')fail('Explicit boolean approval required');
 if(expectedRemoteParent!==remote.parent)fail('Stale remote parent');
 const record=remote.documents.find(d=>d.id===id), p=profile(input.selected);
 if(operation==='publish-new'&&(record||(remote.entries[input.selected]!==null&&!remote.unpublished?.[input.selected])))fail('Publish New requires never-published identity and absent destination');
 if(operation==='publish-changes'&&!record)fail('Published identity not found');
 if(record&&(record.path!==input.selected||record.type!==p.type))fail('Identity/path change requires separate migration');
 const wanted=localPermalink(permalink);
 if(record&&wanted!==record.permalink&&!allowPermalinkChange)fail('Unapproved permalink change');
 const builderOptions={root,selected:input.selected,expectedSourceHash:input.expectedSourceHash,expectedAssets:input.expectedAssets,
 remote,additionalAssets:input.additionalAssets||[],overwriteApprovals:input.overwriteApprovals||{},operation};
 let built=core.makePlan(builderOptions),proposed=Buffer.from(built.files[0].bytes,'base64'),after=parse(proposed,p,'publish-changes');themeValidation(after.data);
 let before=null;
 if(record) {
  if(expectedPublishedHash!==record.sourceHash)fail('Stale published version');
  const prior=remoteBytes(remote,record.path);before=parse(prior,p,'publish-changes');
  if(record.date!==before.data.date)fail('Published date ledger mismatch');
  for(const a of Object.keys(record.assets))remoteBytes(remote,a);
  if(before.data.date!==after.data.date&&!allowDateChange)fail('Unexpected publication-date change');
 }
 const assets=assetDelta(record?record.assets:{},built.files.slice(1));
 for(const a of [...assets.remove,...assets.replace])if(remote.documents.some(d=>d.id!==id&&Object.hasOwn(d.assets,a.path)))fail('Shared asset mutation requires separate approval workflow');
 // Catalogs use independently verified mock published bytes, never local working copies.
 const publishedDocuments=Object.fromEntries(remote.documents.map(d=>[d.path,remoteBytes(remote,d.path)]));
 const priorCatalog=catalog(publishedDocuments,remote.hugoContext||{});
 for(const d of remote.documents)if(priorCatalog.pages[d.path]!==d.permalink)fail('Published ledger/Hugo permalink mismatch');
 let proposedDocuments={...publishedDocuments,[input.selected]:proposed};
 let nextCatalog=catalog(proposedDocuments,{...(remote.hugoContext||{}),allowCollisions:true});
 let pinUrl=null;
 if(record&&nextCatalog.pages[input.selected]!==wanted) {
  const titleChanged=before.data.title!==after.data.title;
  const priorPinMissing=before.data.url===record.permalink&&after.data.url===undefined;
  const safeRetitleOrRepin=(titleChanged||priorPinMissing)&&before.data.date===after.data.date&&before.data.slug===after.data.slug;
  if(allowPermalinkChange||wanted!==record.permalink||after.data.url!==undefined||!safeRetitleOrRepin)fail('Unapproved permalink change or conflicting explicit url');
  pinUrl=record.permalink;
  built=core.makePlan({...builderOptions,pinUrl});proposed=Buffer.from(built.files[0].bytes,'base64');after=parse(proposed,p,'publish-changes');
  proposedDocuments={...publishedDocuments,[input.selected]:proposed};nextCatalog=catalog(proposedDocuments,remote.hugoContext||{});
 }
 // Hugo can warn about duplicate targets yet exit successfully: reject duplicates here.
 if(nextCatalog.collisions.length)fail('Authoritative Hugo URL collision');
 const actual=localPermalink(nextCatalog.pages[input.selected]);
 if(actual!==wanted)fail('Requested permalink disagrees with authoritative Hugo output');
 if(remote.documents.some(d=>d.id!==id&&(d.path===input.selected||d.permalink===actual)))fail('Duplicate publication destination');
 // Prevent publishing over a section, taxonomy, pagination, or an unrelated route.
 if(!actual.startsWith('/'+p.type+'/')||actual==='/'+p.type+'/'||actual.startsWith('/'+p.type+'/page/'))fail('Unsupported or reserved publication route');
 const metadata=before?deltaMetadata(before.data,after.data):[{field:'draft',before:true,after:false}];
 const body=before&&!equal(before.body,after.body)?{beforeHash:hash(before.body),afterHash:hash(after.body)}:null;
 const permalinkChange=record&&actual!==record.permalink?{before:record.permalink,after:actual}:null;
 const review={operation,id,path:input.selected,permalink:actual,previousPublishedHash:record?.sourceHash||null,
 proposedHash:hash(proposed),metadata,body,assets,permalinkChange,transformations:built.manifest.changes};
 if(record&&metadata.length===0&&!body&&!permalinkChange&&Object.values(assets).every(a=>a.length===0))fail('No publication changes');
 const nextIdentity={id,type:p.type,path:input.selected,permalink:actual,date:after.data.date,sourceHash:hash(proposed),assets:Object.fromEntries(built.files.slice(1).map(f=>[f.path,f.hash]))};
 const manifest={...built.manifest,permalink:actual,permalinkAuthority:'hugo-generated',authority:{before:priorCatalog,after:nextCatalog},
 operation,id,previousPermalink:record?record.permalink:null,previousPublishedHash:record?.sourceHash||null,
 proposedHash:hash(proposed),review,removals:assets.remove,nextIdentity};
 const request={...builderOptions,id,expectedRemoteParent,expectedPublishedHash,permalink,allowDateChange,allowPermalinkChange};delete request.root;delete request.remote;
 return clone({id:hash(canonical(manifest)),manifest,files:built.files,request,review,corePlan:built});
}
function approvePublication(prepared,approvedChanges) {
 if(!equal(prepared.review,approvedChanges))fail('Unapproved metadata, body, asset deletion or inclusion');
 return {...clone(prepared),approvedChanges:clone(approvedChanges)};
}
function verifyPublication(plan,{root,remote}) {
 if(!plan.approvedChanges||!equal(plan.approvedChanges,plan.review))fail('Publication approval missing or changed');
 const fresh=preparePublication({...plan.request,root,remote});
 const plain=clone(plan);delete plain.approvedChanges;
 if(!equal(fresh,plain))fail('Snapshot tampering or stale plan');
 return true;
}
function materializePublication(plan,{root,remote,output}) {
 verifyPublication(plan,{root,remote});
 return core.materialize(plan.corePlan,{root,remote,output});
}
module.exports={preparePublication,approvePublication,verifyPublication,materializePublication};
