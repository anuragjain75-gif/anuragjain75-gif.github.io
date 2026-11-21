 'use strict';
// Read-only Hugo authority check. No Git, network adapter, credentials or real-site build.
const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process');
function fail(message){const e=new Error('Metadata URL check: '+message);e.statusCode=422;throw e;}
function csv(text){const rows=[];let row=[],value='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(value);value='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(value);if(row.some(x=>x))rows.push(row);row=[];value='';}else value+=c;}if(quoted)fail('invalid Hugo CSV');if(value||row.length){row.push(value);rows.push(row);}return rows;}
function catalog(tree,environment){
 let output;try{output=cp.execFileSync('/usr/bin/hugo',['list','all','--source',tree],{cwd:tree,env:environment,encoding:'utf8',timeout:30000,maxBuffer:10*1024*1024,stdio:['ignore','pipe','pipe']});}catch{fail('Hugo could not establish permalinks; no manuscript was written');}
 const rows=csv(output),header=rows.shift()||[],pi=header.indexOf('path'),ui=header.indexOf('permalink');if(pi<0||ui<0)fail('unsupported Hugo list output');const result=new Map();
 for(const row of rows){let p=row[pi];if(path.isAbsolute(p))p=path.relative(tree,p);p=p.replaceAll('\\','/').replace(/^\.\//,'');if(!p.startsWith('content/')||result.has(p))fail('ambiguous Hugo document identity');let url;try{url=new URL(row[ui]);}catch{fail('invalid generated URL');}if(!['http:','https:'].includes(url.protocol)||url.search||url.hash)fail('unsupported generated URL');result.set(p,url.pathname);}
 return result;
}
function assertStableURL(files,documentPath,proposed,expectedPermalink){
 if(!(files instanceof Map)||!files.has('hugo.toml')||!files.has(documentPath))fail('incomplete source snapshot');
 const config=files.get('hugo.toml').toString('utf8');
 if(/^\s*\[module(?:\.|\])/m.test(config)||/^\s*theme\s*=/m.test(config.split(/^\s*\[/m)[0]))fail('module/theme configurations require separate verification');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lilamaya-metadata-url-')),identity=fs.lstatSync(root),tree=path.join(root,'site');fs.mkdirSync(tree);fs.mkdirSync(path.join(root,'home'));
 const environment={PATH:'/usr/bin:/bin',HOME:path.join(root,'home'),LANG:'C.UTF-8',TZ:'UTC',HUGO_CACHEDIR:path.join(root,'cache'),HUGO_SECURITY_HTTP_URLS:'none',HUGO_SECURITY_HTTP_METHODS:'none',HUGO_SECURITY_FUNCS_GETENV:'none'};
 try{
  for(const [relative,bytes] of files){if(relative!=='hugo.toml'&&(!relative.startsWith('content/')||!relative.endsWith('.md'))&&!/^layouts\/shortcodes\/(introduction|poetry|invocation)\.html$/.test(relative))fail('unsupported snapshot dependency');if(path.isAbsolute(relative)||relative.split('/').some(s=>!s||s==='.'||s==='..')||/[\\\0]/.test(relative))fail('unsafe snapshot path');const destination=path.join(tree,relative);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,bytes,{flag:'wx'});}
  const before=catalog(tree,environment),old=before.get(documentPath);if(!old)fail('selected document missing from Hugo');if(expectedPermalink!==undefined&&old!==expectedPermalink)fail('loaded permalink is stale; preserve your draft and reopen only after recovery review');
  fs.writeFileSync(path.join(tree,documentPath),proposed);const after=catalog(tree,environment),next=after.get(documentPath);
  if(!next||old!==next)fail('this title/date edit would change the public URL ('+old+' → '+(next||'unavailable')+'). No file was saved; your draft is retained');
  if([...after].some(([p,url])=>p!==documentPath&&url===next))fail('selected public URL collides with another document');
  for(const [p,url] of before)if(p!==documentPath&&after.get(p)!==url)fail('an unrelated URL changed');
  return {before:old,after:next};
 }finally{const now=fs.lstatSync(root);if(now.ino===identity.ino&&now.dev===identity.dev&&!now.isSymbolicLink())fs.rmSync(root,{recursive:true,force:true});}
}
module.exports={assertStableURL,csv};
