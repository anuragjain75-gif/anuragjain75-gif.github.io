'use strict';
// Hugo catalog inputs exist only inside private scratch storage.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {hash,internals:{canonical,safePath,profile}}=require('./editor-publish.cjs');
const {withPrivateScratch}=require('../private-scratch.cjs');
const config=fs.readFileSync(path.join(__dirname,'hugo-foundation/hugo.toml'));
const version=execFileSync('/usr/bin/hugo',['version'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}}).trim();
const cache=new Map();
function localUrl(u) {
 if(typeof u!=='string'||!u.startsWith('/')||u.startsWith('//')||/[\\\s?#\x00-\x1f\x7f]/.test(u))throw new Error('Unsafe permalink');
 const decoded=decodeURIComponent(u);
 if(decoded.startsWith('//')||/[\\?#\x00-\x20\x7f]/.test(decoded)||decoded.split('/').some(p=>p==='.'||p==='..'))throw new Error('Unsafe permalink');
 const url=new URL(u,'https://synthetic.invalid');
 if(url.origin!=='https://synthetic.invalid'||!url.pathname.endsWith('/'))throw new Error('Unsupported permalink form');
 return url.pathname;
}
function csv(text) {
 const rows=[];let row=[],field='',quoted=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
  else if(!quoted&&c===','){row.push(field);field='';}
  else if(!quoted&&c==='\n'){row.push(field.replace(/\r$/,''));rows.push(row);row=[];field='';}
  else field+=c;
 }
 if(quoted)throw new Error('Malformed Hugo catalog');if(field||row.length){row.push(field);rows.push(row);}
 const headers=rows.shift();return rows.filter(x=>x.some(Boolean)).map(x=>Object.fromEntries(headers.map((h,i)=>[h,x[i]])));
}
function catalog(documents,{allowCollisions=false,configuration=config,shortcodeTemplates=null,additionalDocuments={},publishedOnly=false,foundationId=null}={}) {
 const merged={...additionalDocuments,...documents};
 for(const p of Object.keys(documents)){safePath(p);profile(p);}
 for(const p of Object.keys(additionalDocuments)){safePath(p);if(!/^content\/.+\.md$/.test(p))throw new Error('Unsupported shared content path');}
 if(!Buffer.isBuffer(configuration))throw new Error('Verified configuration bytes required');
 const templates=shortcodeTemplates||Object.fromEntries(fs.readdirSync(path.join(__dirname,'hugo-foundation/layouts/shortcodes')).filter(n=>n.endsWith('.html')).map(n=>['layouts/shortcodes/'+n,fs.readFileSync(path.join(__dirname,'hugo-foundation/layouts/shortcodes',n))]));
 for(const [p,b] of Object.entries(templates)){safePath(p);if(!p.startsWith('layouts/shortcodes/')||!p.endsWith('.html')||!Buffer.isBuffer(b))throw new Error('Unsupported shortcode foundation');}
 const sources=Object.fromEntries(Object.entries(merged).sort().map(([p,b])=>[p,hash(b)]));
 const key=hash(canonical({sources,config:hash(configuration),templates:Object.fromEntries(Object.entries(templates).map(([p,b])=>[p,hash(b)])),version,publishedOnly,foundationId}));let value=cache.get(key);
 if(!value)value=withPrivateScratch('catalog',dir=>{
  fs.writeFileSync(path.join(dir,'hugo.toml'),configuration,{flag:'wx'});
  fs.mkdirSync(path.join(dir,'layouts'),{recursive:true});
  for(const [p,b] of Object.entries(templates)){fs.mkdirSync(path.dirname(path.join(dir,p)),{recursive:true});fs.writeFileSync(path.join(dir,p),b,{flag:'wx'});}
  for(const [p,b] of Object.entries(merged)){const f=path.join(dir,p);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b,{flag:'wx'});}
  let output;try { output=execFileSync('/usr/bin/hugo',['list','all','--source',dir],{encoding:'utf8',timeout:20000,env:{PATH:'/usr/bin',HOME:dir,TMPDIR:dir,HUGO_CACHEDIR:path.join(dir,'cache'),HUGO_SECURITY_HTTP_URLS:'none',HUGO_SECURITY_HTTP_METHODS:'none',HUGO_SECURITY_EXEC_ALLOW:'^$'}}); } catch(error) {
    throw new Error('Hugo catalog failed: '+(error.stdout||error.stderr||error.message));
  }
  const rows=csv(output),pages={},drafts={};
  for(const row of rows){if(row.path.endsWith('/_index.md'))continue;if(!Object.hasOwn(sources,row.path)||(Object.hasOwn(pages,row.path)||Object.hasOwn(drafts,row.path)))throw new Error('Unexpected Hugo catalog path');if(!['true','false'].includes(row.draft))throw new Error('Ambiguous Hugo draft classification');(publishedOnly&&row.draft==='true'?drafts:pages)[row.path]=localUrl(new URL(row.permalink).pathname);}
  if(Object.keys(pages).length+Object.keys(drafts).length!==Object.keys(sources).filter(p=>!p.endsWith('/_index.md')).length)throw new Error('Incomplete Hugo catalog');
  const byUrl={};for(const [p,url] of Object.entries(pages))(byUrl[url]||=[]).push(p);
  const collisions=Object.entries(byUrl).filter(([,ps])=>ps.length>1).map(([url,paths])=>({url,paths:paths.sort()}));
  const result={id:key,configHash:hash(configuration),hugoVersion:version,foundationId,sources,pages,drafts,collisions};
  cache.set(key,result);
  return result;
 });
 if(value.collisions.length&&!allowCollisions)throw new Error('Authoritative Hugo URL collision');
 return JSON.parse(JSON.stringify(value));
}
module.exports={catalog,localUrl};
