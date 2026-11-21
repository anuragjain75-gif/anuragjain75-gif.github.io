import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {parseHugoDocument,serializeHugoDocument} from '../../assets/js/lilamaya-document.js';
const source=fs.readFileSync(new URL('../../assets/js/lilamaya-rich-editor.js',import.meta.url),'utf8');
const permitted=['essays','paintings','people','works','ideas','traditions','places','journeys'];
const eligibility=source.slice(source.indexOf('  function shortcodeAllowed('),source.indexOf('  async function insertShortcode('));
const insertion=source.slice(source.indexOf('  async function insertShortcode('),source.indexOf('  // A zero-byte placeholder'));
function fixture(type){
 const options=['poetry','introduction','invocation'].map(value=>({value,disabled:false}));
 const context={documentType:type,shortcodeSelect:{options},segments:[],activeEditor:null};
 const functions=vm.runInNewContext(eligibility+insertion+'\n({allowed:shortcodeAllowed,update:updateShortcodeChoices,insert:insertShortcode})',context);
 return {...functions,options};
}
for(const type of permitted)test('Poetry dropdown and insertion eligibility: '+type,async()=>{
 const f=fixture(type);assert.equal(f.allowed('poetry'),true);f.update();assert.equal(f.options[0].disabled,false);
 // Eligibility must not bypass the existing active-editor/boundary protections.
 await assert.rejects(f.insert('poetry'),/no active editor is available/);
 assert.equal(f.allowed('introduction'),type==='essays');assert.equal(f.allowed('invocation'),false);
});
for(const type of ['fragments','unknown',''])test('Poetry rejected before insertion: '+JSON.stringify(type),async()=>{
 const f=fixture(type);f.update();assert.equal(f.allowed('poetry'),false);assert.equal(f.options[0].disabled,true);await assert.rejects(f.insert('poetry'),/unavailable for the loaded document type/);
 if(type==='fragments')assert.equal(f.allowed('invocation'),true);
});
const builder=vm.runInNewContext('('+source.slice(source.indexOf('function createShortcodeContent('),source.indexOf('function createShortcodeSegment(')).trim()+')');
for(const type of permitted)for(const eol of ['\n','\r\n'])test('Exact Poetry round-trip and protected editing '+type+JSON.stringify(eol),()=>{
 const poetry=builder('poetry','Verse नमस्ते  '+eol+'  Śāntiḥ',eol);
 const original=['---','title: "Synthetic '+type+'"','custom: [keep]','---','','Before  ',''].join(eol)+poetry+eol+'After untouched.'+eol;
 const doc=parseHugoDocument(original);assert.equal(serializeHugoDocument(doc),original);const block=doc.segments.find(s=>s.type==='poetry');assert.ok(block);assert.equal(block.content,poetry);
 block.content=block.content.replace('Verse नमस्ते','Edited verse नमस्ते');assert.equal(serializeHugoDocument(doc),original.replace('Verse नमस्ते','Edited verse नमस्ते'));
});
test('Existing Fragment Poetry is preserved despite new insertion exclusion',()=>{const original='---\ntitle: Fragment\n---\n\n{{< poetry >}}\nKeep this existing verse.  \n{{< /poetry >}}\n';assert.equal(serializeHugoDocument(parseHugoDocument(original)),original);});
test('Existing Hugo Poetry renders for all eight permitted sections',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lilamaya-poetry-eligibility-'));
 fs.mkdirSync(path.join(root,'layouts/shortcodes'),{recursive:true});fs.mkdirSync(path.join(root,'layouts/_default'));
 fs.copyFileSync(new URL('../../layouts/shortcodes/poetry.html',import.meta.url),path.join(root,'layouts/shortcodes/poetry.html'));
 fs.writeFileSync(path.join(root,'layouts/_default/single.html'),'{{ .Content }}');fs.writeFileSync(path.join(root,'hugo.toml'),'baseURL="https://example.invalid/"\ndisableKinds=["taxonomy","term","RSS","sitemap"]\n');
 for(const type of permitted){const dir=path.join(root,'content',type,'synthetic');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'index.md'),'---\ntitle: Synthetic\ndraft: true\n---\n\n'+builder('poetry','Verse '+type+' नमस्ते\n  Indented Śāntiḥ.  '));}
 execFileSync('/usr/bin/hugo',['--source',root,'--buildDrafts','--destination',path.join(root,'public'),'--cacheDir',path.join(root,'cache')],{env:{PATH:'/usr/bin:/bin',HOME:root,LANG:'C.UTF-8'},stdio:'pipe',timeout:30000});
 for(const type of permitted)await t.test(type,()=>{const html=fs.readFileSync(path.join(root,'public',type,'synthetic/index.html'),'utf8');assert.match(html,/<blockquote class="poetry">/);assert.ok(html.includes('Verse '+type+' नमस्ते\n  Indented Śāntiḥ.  '));});
});
