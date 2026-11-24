'use strict';
const fs=require('node:fs'),path=require('node:path');
const {hash,internals:{canonical,parse,profile,dependencies,imageCheck}}=require('./editor-publish.cjs');
const {readRemote,buildTree,safe,oid}=require('./mock-git.cjs');
const {catalog}=require('./hugo-authority.cjs');
const yaml=require('./vendor/js-yaml.cjs');
const {withPrivateScratch}=require('../private-scratch.cjs');
const LEDGER='publication-ledger.json';
const clone=x=>JSON.parse(JSON.stringify(x));
const fail=m=>{throw new Error(m);};
const required=JSON.parse(fs.readFileSync(path.join(__dirname,'foundation-required.json'),'utf8'));
function meta(bytes){const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),m=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);if(!m)fail('Ambiguous remote frontmatter');return yaml.safeLoad(m[1],{schema:yaml.JSON_SCHEMA});}
function imagePath(p){return /\.(png|jpg|jpeg|webp)$/i.test(p)&&(p.startsWith('static/images/')||/^content\/(essays|fragments|paintings)\/[a-z0-9-]+\/(images\/[a-z0-9_-]+|hero(?:-og)?)\.(png|jpg|jpeg|webp)$/i.test(p));}
function context(files,id){
 const shortcodes={};for(const p of Object.keys(files).filter(p=>p.startsWith('layouts/shortcodes/')&&p.endsWith('.html')))shortcodes[p]=files[p];
 const additionalDocuments=Object.fromEntries(Object.entries(files).filter(([p])=>p.startsWith('content/')&&p.endsWith('.md')));
 return {configuration:files['hugo.toml'],shortcodeTemplates:shortcodes,additionalDocuments,publishedOnly:true,foundationId:id};
}
function classifyFiles(files,{parent,tree,modes={},blobOids={},state='remote'}={}) {
 for(const p of Object.keys(files))safe(p);
 for(const p of required)if(!Object.hasOwn(files,p))fail('Missing required shared dependency: '+p);
 if(!files[LEDGER])fail('Missing identity ledger');
 let ledger;try{ledger=JSON.parse(files[LEDGER].toString('utf8'));}catch{fail('Malformed identity ledger');}
 if(ledger.version!==1||!Array.isArray(ledger.documents)||files[LEDGER].toString()!==canonical(ledger)+'\n')fail('Noncanonical or ambiguous identity ledger');
 const ids=new Set(),registered=new Map();
 for(const d of ledger.documents){
  if(!/^urn:lilamaya:synthetic:[a-z0-9-]+$/.test(d.id)||ids.has(d.id)||registered.has(d.path))fail('Identity ledger conflict');ids.add(d.id);safe(d.path);profile(d.path);registered.set(d.path,d);
 }
 const fileHashes=Object.fromEntries(Object.entries(files).sort().map(([p,b])=>[p,hash(b)]));
 const shared=[],unrelated=[],assets=[],documents=[],rows={};
 return withPrivateScratch('inventory',root=>{
  fs.writeFileSync(path.join(root,'SYNTHETIC-ONLY.json'),'{"syntheticOnly":true}\n',{flag:'wx'});
  // Only known manuscript/image paths are materialized for the shared dependency collector.
  for(const [p,b] of Object.entries(files))if(imagePath(p)||/^content\/(essays|fragments|paintings)\/.+\.md$/.test(p)){
   const f=path.join(root,p);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b,{flag:'wx'});
  }
  for(const [p,b] of Object.entries(files).sort()){
   if(p===LEDGER){shared.push({path:p,hash:fileHashes[p],role:'identity-ledger'});continue;}
   if(/^content\/(essays|fragments|paintings)\/.+\.md$/.test(p)&&!p.endsWith('/_index.md')){
    const kind=profile(p),data=meta(b);if(!data||typeof data.draft!=='boolean')fail('Ambiguous published/draft classification');
    const parsed=parse(b,kind,data.draft?'publish-new':'publish-changes');
    const row={path:p,hash:fileHashes[p],type:kind.type,format:kind.bundle?'bundle':'standalone',status:data.draft?'draft':'published',date:parsed.data.date,id:null,assets:{},permalink:null};
    if(data.draft){if(registered.has(p))fail('Draft incorrectly enrolled as published');try{for(const a of dependencies(root,p,kind,parsed.body+'\n'+(parsed.data.introduction||''),parsed.data))if(files[a])row.assets[a]=fileHashes[a];}catch{row.dependencyState='incomplete-draft';}}
    else{
     const record=registered.get(p);if(!record||record.sourceHash!==fileHashes[p]||record.type!==kind.type||record.date!==parsed.data.date)fail('Missing/stale published identity');
     row.id=record.id;const refs=dependencies(root,p,kind,parsed.body+'\n'+(parsed.data.introduction||''),parsed.data);
     for(const asset of refs){if(!files[asset])fail('Missing required image dependency');imageCheck(files[asset],asset);row.assets[asset]=fileHashes[asset];}
     if(canonical(record.assets)!==canonical(row.assets))fail('Stale or incorrect published asset ledger');
    }
    documents.push(row);rows[p]=row;continue;
   }
   if(imagePath(p)){imageCheck(b,p);assets.push({path:p,hash:fileHashes[p],owners:[]});continue;}
   if(p.startsWith('content/')){
    if(!p.endsWith('.md'))fail('Unexpected remote content resource: '+p);
    shared.push({path:p,hash:fileHashes[p],role:'shared-site-content'});continue;
   }
   if(p==='hugo.toml'||p.startsWith('layouts/')||p.startsWith('assets/')||p.startsWith('static/')||p.startsWith('data/')||['package.json','package-lock.json','.gitignore'].includes(p)||p.startsWith('.github/'))shared.push({path:p,hash:fileHashes[p],role:'site-dependency'});
   else unrelated.push({path:p,hash:fileHashes[p],role:/^(public|resources|node_modules)\//.test(p)?'generated-or-install-artifact':'unrelated-repository-file'});
  }
  for(const [p] of registered)if(!rows[p]||rows[p].status!=='published')fail('Published document deleted or identity ledger conflict');
  for(const asset of assets)for(const d of documents){
   const bundlePrefix=path.posix.dirname(d.path)+'/';
   if(Object.hasOwn(d.assets,asset.path)||(d.format==='bundle'&&asset.path.startsWith(bundlePrefix)))asset.owners.push(d.id||'draft:'+d.path);
  }
  const preliminaryId=hash(canonical({parent,tree,fileHashes}));const hugoContext=context(files,preliminaryId);
  const authoritative=catalog({},hugoContext);
  for(const d of documents){d.permalink=d.status==='published'?authoritative.pages[d.path]:authoritative.drafts[d.path];
   if(!d.permalink)fail('Remote classification disagrees with Hugo');
   if(d.status==='published'&&registered.get(d.path).permalink!==d.permalink)fail('Published ledger/Hugo permalink mismatch');
  }
  // A selected asset must not be changed through a shared template or other page reference.
  for(const asset of assets){
   const refs=new Set();if(asset.path.startsWith('static/'))refs.add('/'+asset.path.slice(7));
   for(const d of documents)if(d.format==='bundle'&&asset.path.startsWith(path.posix.dirname(d.path)+'/'))refs.add(d.permalink+asset.path.slice(path.posix.dirname(d.path).length+1));
   if(required.includes(asset.path))asset.owners.push('shared-site:required-foundation');
   for(const dependency of shared.filter(x=>x.path!==LEDGER&&!x.path.startsWith('static/'))){
    const text=files[dependency.path].toString('utf8');
    if([...refs].some(ref=>text.includes(ref)||text.includes(ref.slice(1))))asset.owners.push('shared-site:'+dependency.path);
   }
   asset.owners=[...new Set(asset.owners)].sort();
  }
  const view={version:4,state,parent,tree,fileHashes,modes,blobOids,ledgerHash:fileHashes[LEDGER],documents,assets,shared,unrelated,authoritative};view.id=hash(canonical(view));
  const relevant=Object.fromEntries(Object.entries(files).filter(([p])=>documents.some(d=>d.path===p)||assets.some(a=>a.path===p)));
  const policyRemote={parent,entries:Object.fromEntries(Object.entries(relevant).map(([p])=>[p,fileHashes[p]])),files:Object.fromEntries(Object.entries(relevant).map(([p,b])=>[p,b.toString('base64')])),documents:clone(ledger.documents),unpublished:Object.fromEntries(documents.filter(d=>d.status==='draft').map(d=>[d.path,{sourceHash:d.hash}])),hugoContext};
  return {manifest:view,files,ledger,policyRemote};
 });
}
function inventory(remote){const raw=readRemote(remote);return classifyFiles(raw.files,{...raw,state:'remote'});}
function proposedInventory(files,before){const modes=Object.fromEntries(Object.keys(files).map(p=>[p,before.modes[p]||'100644'])),built=buildTree(Object.fromEntries(Object.entries(files).map(([p,b])=>[p,{bytes:b,mode:modes[p]}])));return classifyFiles(files,{parent:before.parent,tree:built.tree,modes,blobOids:Object.fromEntries(Object.entries(files).map(([p,b])=>[p,oid('blob',b)])),state:'proposed-not-a-commit'});}
function hugoSiteFiles(inv){return Object.fromEntries(Object.entries(inv.files).filter(([p])=>p==='hugo.toml'||['layouts/','assets/','static/','data/','content/'].some(prefix=>p.startsWith(prefix))));}
module.exports={LEDGER,inventory,classifyFiles,proposedInventory,hugoSiteFiles};
