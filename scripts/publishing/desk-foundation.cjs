'use strict';
// M005 foundation extension: same exact manifest -> snapshot -> transaction engine.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),cp=require('child_process');
const core=require('./engine/editor-publish.cjs'),{hash,internals:{canonical,read,safePath}}=core;
const {readRemote,buildTree,oid}=require('./engine/mock-git.cjs');
const {catalog}=require('./engine/hugo-authority.cjs');
const profiles=require('./profiles.cjs');
const LEDGER='publication-ledger.json';
const clone=x=>JSON.parse(JSON.stringify(x));
function fail(m){throw Error(m);}
function context(files){return {configuration:files['hugo.toml'],additionalDocuments:Object.fromEntries(Object.entries(files).filter(([p])=>p.startsWith('content/')&&p.endsWith('.md'))),shortcodeTemplates:Object.fromEntries(Object.entries(files).filter(([p])=>p.startsWith('layouts/shortcodes/')&&p.endsWith('.html'))),desk:true,publishedOnly:true};}
function ledgerFor(raw){
 let ledger={version:1,documents:[]};if(raw.files[LEDGER]){try{ledger=JSON.parse(raw.files[LEDGER]);}catch{fail('Invalid publication ledger');}}
 if(ledger.version!==1||!Array.isArray(ledger.documents))fail('Unsupported publication ledger');
 const ids=new Set(),paths=new Set(),urls=new Set();
 for(const d of ledger.documents){if(!/^urn:lilamaya:(?:entry|synthetic):[a-z0-9-]+$/.test(d.id)||ids.has(d.id)||paths.has(d.path)||urls.has(d.permalink)||!raw.files[d.path]||hash(raw.files[d.path])!==d.sourceHash)fail('Ambiguous or stale identity ledger');ids.add(d.id);paths.add(d.path);urls.add(d.permalink);}
 return ledger;
}
function classify(raw){const c=catalog({},context(raw.files));return {catalog:c,ledger:ledgerFor(raw)};}
function build(files,selected,permalink,work){
 const root=fs.mkdtempSync(path.join(work,'hugo-')),site=path.join(root,'site'),out=path.join(root,'public');fs.mkdirSync(site,{mode:0o700});
 for(const [p,b]of Object.entries(files))if(p==='hugo.toml'||['content/','layouts/','assets/','static/','data/'].some(prefix=>p.startsWith(prefix))){safePathForSite(p);const dest=path.join(site,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,b,{flag:'wx'});}
 const env={PATH:'/usr/bin:/bin',HOME:root,LANG:'C.UTF-8',TZ:'UTC',HUGO_SECURITY_HTTP_URLS:'none',HUGO_SECURITY_HTTP_METHODS:'none',HUGO_SECURITY_FUNCS_GETENV:'^HUGO_',HUGO_SECURITY_EXEC_ALLOW:'^$'};
 let log;try{log=cp.execFileSync('/usr/bin/hugo',['--source',site,'--destination',out,'--cacheDir',path.join(root,'cache'),'--minify','--printPathWarnings'],{env,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']});}catch{fail('Candidate Hugo build failed; nothing submitted');}
 fs.writeFileSync(path.join(root,'build.log'),log);
 const page=path.join(out,decodeURIComponent(permalink).replace(/^\//,''),'index.html');if(!fs.existsSync(page))fail('Hugo did not render the selected page (check draft/publication dates)');
 const html=fs.readFileSync(page),siteOrigin=new URL(files['hugo.toml'].toString().match(/^baseURL\s*=\s*"([^"]+)"/m)?.[1]||'https://invalid.invalid/').origin;
 const assets={};
 const tags=html.toString().matchAll(/<(img|source|meta)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi);
 for(const [tag,name] of tags){
  const attributes=Object.fromEntries([...tag.matchAll(/\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
   .map(([,key,double,single,bare])=>[key.toLowerCase(),double??single??bare]));
  const social=attributes.property==='og:image'||attributes.name==='twitter:image';
  const references=name.toLowerCase()==='meta'?(social?[attributes.content]:[]):[attributes.src,...(attributes.srcset||'').split(',').map(item=>item.trim().split(/\s+/)[0])];
  for(const ref of references.filter(Boolean)){
   const url=new URL(ref.replace(/&amp;/g,'&'),siteOrigin+permalink);
   if(url.origin!==siteOrigin)fail('External preview image dependency is not locally verifiable');
   const assetPath=decodeURIComponent(url.pathname).slice(1);
   safePathForSite(assetPath);
   const asset=path.join(out,assetPath);
   if(!fs.existsSync(asset)||!fs.statSync(asset).isFile())fail('Rendered image is missing: '+url.pathname);
   assets[url.pathname]=hash(fs.readFileSync(asset));
  }
 }
 return {url:permalink,siteOrigin,htmlHash:hash(html),assets,html:html.toString('base64'),buildRoot:root};
}
function safePathForSite(p){if(typeof p!=='string'||p.startsWith('/')||p.split('/').some(x=>!x||x==='.'||x==='..')||/[\\\0]/.test(p))fail('Unsafe candidate dependency path');}
function prepare({localRoot,remote,expectedFoundationId,documentRequest:r}){
 const raw=readRemote(remote),base=classify(raw);if(r.expectedRemoteParent!==raw.parent)fail('Remote parent changed');
 const foundationId=hash(canonical({parent:raw.parent,tree:raw.tree}));if(expectedFoundationId&&expectedFoundationId!==foundationId)fail('Remote foundation changed');
 const p=profiles.profile(r.selected),bytes=read(localRoot,r.selected);if(hash(bytes)!==r.expectedSourceHash)fail('Stale saved manuscript');
 const parsed=profiles.parse(bytes,p),old=raw.files[r.selected],oldParsed=old?profiles.parse(old,p):null;
 const record=base.ledger.documents.find(d=>d.path===r.selected),published=oldParsed&&oldParsed.data.draft===false;
 if(record&&record.sourceHash!==hash(old))fail('Changed published version');
 const operation=published||record?'publish-changes':'publish-new';
 const oldURL=base.catalog.pages[r.selected]||base.catalog.drafts[r.selected];
 const id=record?.id||r.identity;if(!/^urn:lilamaya:entry:[a-z0-9-]+$/.test(id||''))fail('An explicitly reviewed stable identity is required');
 const builderRemote={parent:raw.parent,entries:{[r.selected]:old?hash(old):null}};for(const name of Object.keys(r.expectedAssets||{}))builderRemote.entries[name]=raw.files[name]?hash(raw.files[name]):null;
 let built=core.makePlan({root:localRoot,selected:r.selected,expectedSourceHash:r.expectedSourceHash,expectedAssets:r.expectedAssets,remote:builderRemote,overwriteApprovals:r.overwriteApprovals||{},operation,desk:true});
 const files=Object.fromEntries(Object.entries(raw.files).map(([p,b])=>[p,Buffer.from(b)]));
 for(const f of built.files){
  if(f.path!==r.selected&&raw.files[f.path]&&hash(raw.files[f.path])!==f.hash){
   const own=record?.assets&&Object.hasOwn(record.assets,f.path)||f.path.startsWith(path.posix.dirname(r.selected)+'/')||f.path===`static/images/social/${p.type}/${p.slug}.png`;
   if(!own||base.ledger.documents.some(d=>d.id!==id&&d.assets&&Object.hasOwn(d.assets,f.path)))fail('Shared or unreviewed asset overwrite');
  }
  files[f.path]=Buffer.from(f.bytes,'base64');
 }
 for(const companion of r.companions||[]){
  if(!['essays','paintings'].includes(p.type)||companion!==`data/lilamaya_social_cards/${p.type}/${p.slug}.json`)fail('Unapproved companion file');
  const bytes=read(localRoot,companion),data=JSON.parse(bytes);if(Object.keys(data).join()!=='cardHash'||data.cardHash!==r.expectedAssets[`static/images/social/${p.type}/${p.slug}.png`])fail('Invalid selected social-card companion');files[companion]=bytes;
 }
 let after=catalog({},context(files)),url=after.pages[r.selected];if(!url)fail('Selected source is not publishable');
 if(oldURL&&url!==oldURL){
  if(!published||parsed.data.url!==undefined||parsed.data.date!==oldParsed.data.date||parsed.data.slug!==oldParsed.data.slug)fail('This revision changes its public URL; a separate migration is required');
  built=core.makePlan({root:localRoot,selected:r.selected,expectedSourceHash:r.expectedSourceHash,expectedAssets:r.expectedAssets,remote:builderRemote,overwriteApprovals:r.overwriteApprovals||{},operation,desk:true,pinUrl:oldURL});
  files[r.selected]=Buffer.from(built.files[0].bytes,'base64');after=catalog({},context(files));url=after.pages[r.selected];if(url!==oldURL)fail('Hugo did not preserve the established public URL');
 }
 if(record&&record.permalink!==url)fail('Unapproved permalink change');
 if(published&&canonical({date:oldParsed.data.date,publishDate:oldParsed.data.publishDate})!==canonical({date:parsed.data.date,publishDate:parsed.data.publishDate}))fail('Publication date changed; approval outside this workflow is required');
 profiles.connections(parsed.data,after.pages,url);
 for(const [q,u]of Object.entries(base.catalog.pages))if(q!==r.selected&&after.pages[q]!==u)fail('Unrelated publication route changed');
 const assets=Object.fromEntries(built.files.slice(1).map(f=>[f.path,f.hash]));
 const nextIdentity={id,type:p.type,path:r.selected,permalink:url,date:parsed.data.date||null,sourceHash:hash(files[r.selected]),assets};
 const ledger=clone(base.ledger),at=ledger.documents.findIndex(d=>d.id===id);if(at<0)ledger.documents.push(nextIdentity);else ledger.documents[at]=nextIdentity;
 const enrollment=published&&!record;
 files[LEDGER]=Buffer.from(canonical(ledger)+'\n');
 const changed=[...built.files.map(f=>f.path),...(r.companions||[]),LEDGER].filter((p,i,a)=>a.indexOf(p)===i).sort().map(p=>({path:p,action:!raw.files[p]?'add':hash(raw.files[p])===hash(files[p])?'reuse':'update',before:raw.files[p]?hash(raw.files[p]):null,after:hash(files[p])}));
 const contentChange=changed.some(c=>c.path!==LEDGER&&c.action!=='reuse');if(!contentChange&&record)fail('No publication changes');
 const proof=build(files,r.selected,url,r.work);
 const tree=buildTree(Object.fromEntries(Object.entries(files).map(([p,b])=>[p,{bytes:b,mode:raw.modes[p]||'100644'}]))).tree;
 const fileHashes=Object.fromEntries(Object.entries(files).sort().map(([p,b])=>[p,hash(b)]));
 const metadataBefore=oldParsed?.data||{},metadataAfter=profiles.parse(files[r.selected],p).data;
 const fields=[...new Set([...Object.keys(metadataBefore),...Object.keys(metadataAfter)])].filter(k=>canonical(metadataBefore[k])!==canonical(metadataAfter[k])).map(field=>({field,before:metadataBefore[field]??null,after:metadataAfter[field]??null}));
 const review={target:r.target,committer:r.committer,operation,path:r.selected,title:parsed.data.title,type:p.type,permalink:url,expectedParent:raw.parent,identity:id,enrollment,ledgerInitialization:!raw.files[LEDGER],files:changed.filter(c=>c.action!=='reuse'),metadata:fields,transformations:built.manifest.changes,sourceDiff:{before:old?.toString('utf8')||'',after:files[r.selected].toString('utf8')},removals:[],retainedFormerAssets:Object.keys(record?.assets||{}).filter(a=>!Object.hasOwn(assets,a))};
 const manifest={version:5,desk:true,target:r.target,expectedRemoteParent:raw.parent,foundationId,identity:nextIdentity,permalink:url,exactChanges:changed,expectedPostInventory:{fileHashes,tree},proof,review,sourcePaths:built.manifest.files,committer:r.committer};
 const payload=changed.filter(c=>c.action!=='reuse').map(c=>({path:c.path,hash:c.after,bytes:files[c.path].toString('base64')}));
 // Build paths are diagnostic, not plan identity. Rendered bytes/hashes are bound.
 delete proof.buildRoot;
 return {id:hash(canonical(manifest)),manifest,review,payload,request:{localRoot,expectedFoundationId,documentRequest:r}};
}
function verify(plan,{localRoot,remote}){
 if(canonical(plan.review)!==canonical(plan.approvedReview))fail('Exact review confirmation required');
 const fresh=prepare({...plan.request,localRoot,remote});const plain=clone(plan);delete plain.approvedReview;if(canonical(fresh)!==canonical(plain))fail('Reviewed source, dependencies, parent or plan changed');return true;
}
module.exports={prepare,verify,classify,build,LEDGER};
