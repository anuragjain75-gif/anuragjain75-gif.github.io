'use strict';
// Offline only. No Git, subprocess, credentials, network or application imports.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('./vendor/js-yaml.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const canonical = value => JSON.stringify(value, (key, v) => v && !Array.isArray(v) && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
function safePath(p) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || /[\\\x00-\x20\x7f%?#:]/.test(p) ||
      p.split('/').some(x => !x || x === '.' || x === '..' || x.startsWith('.'))) fail('Unsafe path');
  return p;
}
function checkAncestors(p) {
  let current = path.parse(p).root;
  for (const part of p.slice(current.length).split('/').filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) fail('Symlink ancestor');
  }
}
function rootCheck(root, desk=false) {
  if (!path.isAbsolute(root)) fail('Absolute synthetic root required');
  checkAncestors(root);
  if(desk){if(read(root,'PUBLICATION-CAPTURE.json').toString()!=='{"publicationCapture":true}\n')fail('Private publication capture required');return;}
  const marker = read(root, 'SYNTHETIC-ONLY.json');
  if (marker.toString() !== '{"syntheticOnly":true}\n') fail('Synthetic root marker required');
}
function read(root, relative) {
  safePath(relative);
  let fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const parts = relative.split('/');
    for (const part of parts.slice(0, -1)) {
      const next = fs.openSync(`/proc/self/fd/${fd}/${part}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      fs.closeSync(fd); fd = next;
    }
    const file = fs.openSync(`/proc/self/fd/${fd}/${parts.at(-1)}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const a = fs.fstatSync(file, {bigint: true});
      if (!a.isFile() || a.size > 20n * 1024n * 1024n) fail('Unsupported file');
      const bytes = fs.readFileSync(file), b = fs.fstatSync(file, {bigint: true});
      if (a.ino !== b.ino || a.size !== b.size || a.mtimeNs !== b.mtimeNs || a.ctimeNs !== b.ctimeNs) fail('Concurrent file change');
      return bytes;
    } finally { fs.closeSync(file); }
  } finally { fs.closeSync(fd); }
}
function profile(selected, options={}) {
  if(options.desk)return require('../profiles.cjs').profile(selected);
  safePath(selected);
  const match = /^content\/(essays|fragments|paintings)\/([a-z0-9][a-z0-9-]*)(\/index)?\.md$/.exec(selected);
  if (!match || (match[1] !== 'fragments' && !match[3]) || match[2] === '_index') fail('Unsupported document path');
  return {type: match[1], slug: match[2], bundle: !!match[3]};
}
function parse(bytes, p, operation = 'publish-new') {
  if(p.desk)return require('../profiles.cjs').parse(bytes,p,operation);
  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff || bytes.subarray(0, 3).equals(Buffer.from([239,187,191]))) fail('BOM unsupported');
  if (/\r(?!\n)/.test(text) || (text.includes('\r\n') && /(?<!\r)\n/.test(text))) fail('Mixed or invalid line endings');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);
  const end = lines.indexOf('---', 1);
  if (lines[0] !== '---' || end < 2) fail('YAML frontmatter required');
  const header = lines.slice(1,end).join(eol);
  // No YAML alias/merge ambiguity; safe schema rejects executable tags and duplicate keys.
  if (/(^|[\s:[,{])[*&][\w-]+|^\s*<<:/m.test(header)) fail('YAML aliases unsupported');
  const data = yaml.safeLoad(header, {schema: yaml.JSON_SCHEMA});
  if (!data || Array.isArray(data) || typeof data !== 'object') fail('Invalid metadata');
  const common = ['title','date','draft','introduction','slug','url'];
  const fields = [...common, p.type === 'essays' ? 'themes' : p.type === 'fragments' ? 'fragmentthemes' : 'paintingthemes', ...(p.type === 'paintings' ? ['artist','year'] : [])];
  for (const k of Object.keys(data)) if (!fields.includes(k)) fail('Unsupported metadata dependency: '+k);
  if (typeof data.title !== 'string' || !data.title.trim()) fail('Title required');
  if (typeof data.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.date) || !Number.isFinite(Date.parse(data.date)) || new Date(data.date).toISOString().slice(0,10) !== data.date) fail('Valid date required');
  if (operation === 'publish-new' ? data.draft !== true : data.draft !== false) fail(operation === 'publish-new' ? 'Unambiguous draft true required' : 'Published revision requires draft false');
  if (data.slug !== undefined && (typeof data.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(data.slug))) fail('Unsupported explicit slug');
  if (data.url !== undefined && (typeof data.url !== 'string' || !/^\/(?!\/)[a-z0-9/-]+\/$/.test(data.url) || data.url.split('/').some(x=>x==='.'||x==='..'))) fail('Unsafe explicit url');
  if (data.introduction !== undefined && typeof data.introduction !== 'string') fail('Invalid introduction');
  for (const k of ['themes','fragmentthemes','paintingthemes']) if (data[k] !== undefined && (!Array.isArray(data[k]) || data[k].some(x => typeof x !== 'string' || !x.trim()))) fail('Invalid themes');
  if (p.type === 'paintings' && (typeof data.artist !== 'string' || !data.artist.trim() || !['string','number'].includes(typeof data.year) || !/^\d{4}$/.test(String(data.year)))) fail('Painting artist/year required');
  const draftLines = lines.slice(1,end).map((x,i) => ({x,i:i+1})).filter(o => (operation === 'publish-new' ? /^draft:[ \t]*true[ \t]*(?:#.*)?$/ : /^draft:[ \t]*false[ \t]*(?:#.*)?$/).test(o.x));
  if (draftLines.length !== 1) fail('Unsupported draft spelling');
  const line = draftLines[0];
  const offset = Buffer.byteLength(lines.slice(0,line.i).join(eol)+eol+line.x.slice(0,line.x.indexOf(operation === 'publish-new' ? 'true' : 'false')));
  const published = operation === 'publish-new' ? Buffer.concat([bytes.subarray(0,offset),Buffer.from('false'),bytes.subarray(offset+4)]) : Buffer.from(bytes);
  return {closingOffset:Buffer.byteLength(lines.slice(0,end).join(eol)+eol),eol,data, body: lines.slice(end+1).join(eol), published, offset};
}
function imageCheck(bytes, name) {
  const ext = path.posix.extname(name).toLowerCase();
  if (ext === '.png' && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) return;
  if (['.jpg','.jpeg'].includes(ext) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return;
  if (ext === '.webp' && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return;
  fail('Invalid or unsupported image');
}
function dependencies(root, selected, p, body, metadata) {
  if(p.desk)return require('../profiles.cjs').dependencies(root,selected,p,body,metadata);
  if (/<\/?[a-z!]|\]\s*\[|^\s*\[[^\]]+\]:/im.test(body)) fail('HTML/reference dependencies unsupported');
  let remaining = body;
  for (const m of body.matchAll(/{{[<%][\s\S]*?[>%]}}/g)) {
    if (!/^{{<\s*(?:\/?poetry|introduction|invocation)\s*>}}$/.test(m[0])) fail('Unsupported shortcode');
    if (/introduction/.test(m[0]) && !metadata.introduction?.trim()) fail('Introduction metadata missing');
    remaining = remaining.replace(m[0],'');
  }
  if (/{{|}}/.test(remaining)) fail('Malformed shortcode');
  const refs = new Set();
  remaining = remaining.replace(/!\[([^\]\n]*)\]\(([^()\s]+)\)/g, (all, alt, src) => {
    let rel;
    if (src.startsWith('/images/')) rel = 'static'+src;
    else {
      safePath(src);
      if (!p.bundle) fail('Standalone local images require /images/ static paths');
      if (!/^(?:images\/[a-z0-9][a-z0-9_-]*|hero(?:-og)?)\.(?:png|jpg|jpeg|webp)$/i.test(src)) fail('Unsupported image reference');
      rel = path.posix.dirname(selected)+'/'+src;
    }
    safePath(rel); refs.add(rel); return '';
  });
  if (/!\[|\]\(/.test(remaining)) fail('Unsupported image or link dependency');
  if (p.bundle) {
    const dir = path.posix.dirname(selected);
    let fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    let names;
    try {
      for (const part of dir.split('/')) {
        const next = fs.openSync(`/proc/self/fd/${fd}/${part}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        fs.closeSync(fd); fd = next;
      }
      names = fs.readdirSync(`/proc/self/fd/${fd}`).filter(n => /^hero\./i.test(n));
    } finally { fs.closeSync(fd); }
    if (names.some(n => !/^hero\.(jpg|jpeg|png|webp)$/.test(n))) fail('Unsupported hero dependency');
    const heroes = names.map(n => n.slice(5));
    if (heroes.length > 1 || (p.type === 'paintings' && heroes.length !== 1)) fail('Missing or ambiguous hero');
    for (const ext of heroes) refs.add(dir+'/hero.'+ext);
  }
  // head.html emits this asset even when it is not referenced by the manuscript body.
  refs.add(`static/images/social/${p.type}/${p.slug}.png`);
  return [...refs].sort();
}
function remoteCheck(remote) {
  if (!remote || !/^[a-f0-9]{40}$/.test(remote.parent) || !remote.entries || typeof remote.entries !== 'object' || Array.isArray(remote.entries)) fail('Mock remote parent/tree required');
  for (const [k,v] of Object.entries(remote.entries)) { safePath(k);if (v !== null && !/^[a-f0-9]{64}$/.test(v)) fail('Invalid remote hash'); }
}
function makePlan({root, selected, expectedSourceHash, expectedAssets, remote, additionalAssets = [], overwriteApprovals = {}, operation = 'publish-new', pinUrl = null, desk = false}) {
  rootCheck(root,desk);remoteCheck(remote);
  if (!['publish-new','publish-changes'].includes(operation)) fail('Unsupported operation');
  const p=profile(selected,{desk}), original=read(root,selected);
  if (hash(original)!==expectedSourceHash) fail('Stale manuscript');
  const parsed=parse(original,p,operation);
  const transformations=(desk ? parsed.data.draft : operation === 'publish-new') ? [{path:selected,offset:parsed.offset,remove:'true',insert:'false'}] : [];
  if(pinUrl!==null) {
    if(operation!=='publish-changes'||parsed.data.url!==undefined||typeof pinUrl!=='string'||!/^\/(?!\/)[a-z0-9/-]+\/$/.test(pinUrl)||pinUrl.split('/').some(x=>x==='.'||x==='..'))fail('Unsafe URL pin');
    const insert='url: '+JSON.stringify(pinUrl)+parsed.eol;
    const insertionOffset=parsed.closingOffset+(desk&&parsed.data.draft?1:0);
    parsed.published=Buffer.concat([parsed.published.subarray(0,insertionOffset),Buffer.from(insert),parsed.published.subarray(insertionOffset)]);
    transformations.push({path:selected,offset:parsed.closingOffset,remove:'',insert});
  }
  const required=dependencies(root,selected,p,parsed.body+"\n"+(parsed.data.introduction||""),parsed.data);
  const extras=[];
  for(const x of additionalAssets) {safePath(x);if(!/^static\/images\/[a-zA-Z0-9_/-]+\.(png|jpg|jpeg|webp)$/.test(x))fail('Unsupported additional asset');extras.push(x);}
  const assets=[...required,...extras];
  if(new Set(assets).size!==assets.length)fail('Duplicate destination');
  if (!expectedAssets || canonical(Object.keys(expectedAssets).sort())!==canonical([...assets].sort()))fail('Exact asset revisions required');
  const files=[{path:selected,sourceHash:hash(original),hash:hash(parsed.published),bytes:parsed.published.toString('base64')}];
  for(const name of assets.sort()) {
    const bytes=read(root,name),digest=hash(bytes);imageCheck(bytes,name);
    if(expectedAssets[name]!==digest)fail('Stale asset');
    files.push({path:name,sourceHash:digest,hash:digest,bytes:bytes.toString('base64')});
  }
  for(const f of files) {
    if(!Object.hasOwn(remote.entries,f.path))fail('Unknown remote destination');
    const old=remote.entries[f.path];
    if(f.path!==selected && old!==null && old!==f.hash && overwriteApprovals[f.path]!==old)fail('Unreviewed asset overwrite');
  }
  const manifest={version:1,syntheticOnly:true,selected,type:p.type,format:p.bundle?'bundle':'standalone',
    permalink:p.type==='fragments'?`/fragments/${parsed.data.date.replaceAll('-','/')}/${p.slug}/`:`/${p.type}/${p.slug}/`,
    expectedRemoteParent:remote.parent,remoteEntries:Object.fromEntries(files.map(f=>[f.path,remote.entries[f.path]])),
    changes:transformations,permalinkAuthority:'legacy-unverified-hint-not-for-publication',
    files:files.map(({bytes,...f})=>f)};
  return {id:hash(canonical(manifest)),manifest,files,request:{selected,expectedSourceHash,expectedAssets,additionalAssets,overwriteApprovals,operation,pinUrl,desk}};
}
function verifyPlan(plan,{root,remote}) {
  if(plan.id!==hash(canonical(plan.manifest)))fail('Plan identity mismatch');
  if(remote.parent!==plan.manifest.expectedRemoteParent)fail('Remote branch changed');
  const rebuilt=makePlan({root,remote,...plan.request});
  if(canonical(rebuilt)!==canonical(plan))fail('Stale or tampered plan');
  return true;
}
function materialize(plan,{root,remote,output}) {
  verifyPlan(plan,{root,remote});
  if(!path.isAbsolute(output) || output===root || output.startsWith(root+'/'))fail('Separate absolute output required');
  checkAncestors(path.dirname(output));
  fs.mkdirSync(output,{mode:0o700}); // exclusive: existing snapshots are never overwritten.
  for(const f of plan.files) {
    const dest=path.join(output,f.path);fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});
    fs.writeFileSync(dest,Buffer.from(f.bytes,'base64'),{flag:'wx',mode:0o600});
  }
  // Evidence lives outside the exact publication payload, returned to the caller.
  return plan.files.map(f=>f.path).sort();
}
function classifyOutcome({expectedParent,commit,observedParent,deployment}) {
  if(observedParent===commit)return deployment==='success'?'deployment-confirmed':'submitted-not-confirmed-live';
  if(observedParent===expectedParent)return 'not-observed-do-not-retry-blindly';
  return 'uncertain-stop';
}
module.exports={makePlan,verifyPlan,materialize,classifyOutcome,hash,internals:{canonical,profile,parse,read,rootCheck,safePath,dependencies,imageCheck}};
