'use strict';
// Nine current catalog types. This extends M005's profile/parse/dependency hooks.
const path=require('path');
const yaml=require('./engine/vendor/js-yaml.cjs');
const {hash,internals:{safePath,canonical}}=require('./engine/editor-publish.cjs');
const TYPES=Object.freeze({essays:'Essay',fragments:'Fragment',paintings:'Painting',people:'Person',works:'Work',ideas:'Idea',traditions:'Tradition',places:'Place',journeys:'Journey'});
const THEMES={essays:'themes',fragments:'fragmentthemes',paintings:'paintingthemes'};
const fail=m=>{throw Error(m);};
function profile(selected){safePath(selected);const parts=selected.split('/');if(parts[0]!=='content'||!TYPES[parts[1]]||!selected.endsWith('.md')||parts.at(-1)==='_index.md'||parts.length<3)fail('Unsupported catalog entry');const bundle=parts.at(-1)==='index.md';return {desk:true,type:parts[1],slug:bundle?parts.at(-2):parts.at(-1).slice(0,-3),bundle};}
function parse(bytes,p,operation){
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),m=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);if(!m||/^\ufeff/.test(text)||/\r(?!\n)/.test(text)||(text.includes('\r\n')&&/(?<!\r)\n/.test(text)))fail('Unambiguous UTF-8 YAML with consistent line endings is required');
 if(/(^|[\s:[,{])[*&][\w-]+|^\s*<<:/m.test(m[1]))fail('YAML aliases/merges are unsupported');
 const data=yaml.safeLoad(m[1],{schema:yaml.JSON_SCHEMA});if(!data||typeof data!=='object'||Array.isArray(data)||typeof data.title!=='string'||!data.title.trim())fail('A title and valid metadata mapping are required');
 const common=['title','date','publishDate','lastmod','draft','slug','url','description','connections'];
 const allowed=[...common,...(THEMES[p.type]?[THEMES[p.type],'introduction']:['stage','hero']),...(['essays','paintings'].includes(p.type)?['hero']:[]),...(p.type==='paintings'?['artist','year']:[])];
 for(const key of Object.keys(data))if(!allowed.includes(key))fail('Unsupported metadata dependency: '+key);
 for(const key of ['date','publishDate','lastmod'])if(data[key]!==undefined&&(typeof data[key]!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(data[key])||!require('../../assets/js/lilamaya-metadata-patch.cjs').validDate(data[key])))fail('Invalid '+key);
 if(typeof data.draft!=='boolean')fail('An explicit boolean draft state is required');
 if(data.slug!==undefined&&(typeof data.slug!=='string'||!data.slug.trim()||/[\\/#?\x00-\x1f]/.test(data.slug)))fail('Unsafe slug');
 if(data.url!==undefined&&(typeof data.url!=='string'||!/^\/(?!\/)/.test(data.url)||/[\\\s?#]/.test(data.url)||data.url.split('/').some(x=>x==='.'||x==='..')))fail('Unsafe explicit URL');
 if(data.introduction!==undefined&&typeof data.introduction!=='string')fail('Invalid introduction');
 if(THEMES[p.type]&&data[THEMES[p.type]]!==undefined){const ts=data[THEMES[p.type]];if(!Array.isArray(ts)||ts.some(v=>typeof v!=='string'||!v.trim()||v!==v.trim())||new Set(ts.map(v=>v.toLowerCase())).size!==ts.length)fail('Ambiguous theme assignments');}
 if(p.type==='paintings'&&(typeof data.artist!=='string'||!data.artist.trim()||!/^\d{4}$/.test(String(data.year))))fail('Painting artist/year are required');
 if(data.hero!==undefined&&data.hero!==false&&(typeof data.hero!=='string'||!data.hero.trim()))fail('Invalid hero association');
 for(const key of ['description','stage'])if(data[key]!==undefined&&typeof data[key]!=='string')fail('Invalid '+key);
 const eol=text.includes('\r\n')?'\r\n':'\n',lines=text.split(eol),end=lines.indexOf('---',1);
 const matches=[...text.slice(0,m[0].length).matchAll(/^draft:[ \t]*(true|false)[ \t]*(?:#.*)?$/gm)];if(matches.length!==1)fail('Unambiguous top-level draft spelling is required');
 const line=matches[0],start=line.index+line[0].indexOf(line[1]),offset=Buffer.byteLength(text.slice(0,start));
 const published=data.draft?Buffer.concat([bytes.subarray(0,offset),Buffer.from('false'),bytes.subarray(offset+4)]):Buffer.from(bytes);
 return {data,body:text.slice(m[0].length),eol,published,offset,closingOffset:Buffer.byteLength(lines.slice(0,end).join(eol)+eol)};
}
function assetPath(selected,reference){
 if(typeof reference!=='string'||/[\\\s?#]/.test(reference))fail('Unsupported local image reference');
 if(reference.startsWith('/images/'))return safePath('static'+reference);
 safePath(reference);if(!selected.endsWith('/index.md'))fail('Standalone images require an explicit /images/ reference');
 return safePath(path.posix.dirname(selected)+'/'+reference);
}
function dependencies(root,selected,p,body,metadata){
 const fs=require('fs'),refs=new Set();let text=body+'\n'+(metadata.introduction||'');
 const dependencyText=text.replace(/^<br \/>$/gm,'');
 if(/<\/?[A-Za-z!]|\]\s*\[|^\s*\[[^\]]+\]:/m.test(dependencyText))fail('HTML/reference dependencies require explicit review; they are not guessed');
 for(const m of text.matchAll(/{{[<%][\s\S]*?[>%]}}/g))if(!/^{{<\s*(?:\/?poetry|\/?invocation|introduction)\s*>}}$/.test(m[0]))fail('Unsupported shortcode dependency');
 for(const m of text.matchAll(/!\[[^\]\n]*\]\(([^()\s]+)\)/g))refs.add(assetPath(selected,m[1]));
 if(metadata.hero===false){}else if(typeof metadata.hero==='string')refs.add(assetPath(selected,metadata.hero));
 else if(p.bundle&&['essays','paintings'].includes(p.type)){
  const names=fs.readdirSync(path.join(root,path.posix.dirname(selected))).filter(n=>/^hero\./i.test(n));
  if(names.length>1)fail('Ambiguous legacy hero resources');
  if(names.length)refs.add(path.posix.dirname(selected)+'/'+names[0]);
  if(p.type==='paintings'&&!names.length)fail('Painting needs an explicit hero, hero:false, or one legacy hero resource');
 }
 // Current head.html has social-card contracts only for these three sections.
 if(THEMES[p.type])refs.add(`static/images/social/${p.type}/${p.slug}.png`);
 return [...refs].sort();
}
function connections(data,pages,selectedURL){
 if(data.connections===undefined)return;
 if(!Array.isArray(data.connections)||data.connections.length>50)fail('Invalid connections');const seen=new Set();
 for(const c of data.connections){if(!c||typeof c!=='object'||!Object.values(pages).includes(c.target)||c.target===selectedURL||seen.has(c.target))fail('Connection target is missing or unpublished: '+c?.target);seen.add(c.target);if(!['authored','authored-by','explores','influenced','influenced-by','disagrees-with','belongs-to','related-to'].includes(c.relation)||!['documented','interpretive'].includes(c.basis||'interpretive')||(c.note!==undefined&&(typeof c.note!=='string'||c.note.length>500)))fail('Invalid connection metadata');}
}
module.exports={TYPES,THEMES,profile,parse,dependencies,assetPath,connections};
