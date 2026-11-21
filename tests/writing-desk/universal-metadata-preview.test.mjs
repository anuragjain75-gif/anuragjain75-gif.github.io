import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {METADATA_SCHEMAS} from '../../assets/js/lilamaya-metadata-panel.js';
const require=createRequire(import.meta.url),patch=require('../../assets/js/lilamaya-metadata-patch.cjs');
const types=Object.keys(patch.FIELDS),litverse=types.filter(t=>!patch.THEMES[t]);
const source=e=>['---',"title: 'Old title' # title comment",'date: 2026-11-21T12:34:56.123+05:30','draft: true','description: Keep description','hero: legacy-reference.jpg','stage: developing','unknown: {keep: [one, two]}','# preserve comment','---','','{{< poetry >}}','Śāntiḥ  ','untouched poetry','{{< /poetry >}}','','Body  ',''].join(e);
for(const type of types)for(const e of ['\n','\r\n'])test('Only title source token changes '+type+JSON.stringify(e),()=>{
 const original=source(e),next=patch.patchMetadata(original,type,{title:'New title'});
 assert.equal(next,original.replace("'Old title'","'New title'"));assert.equal(patch.parse(next).data.title,'New title');assert.equal(patch.parse(next).body,patch.parse(original).body);
});
for(const type of types)test('No-op and protected keys '+type,()=>{
 const original=source('\n');assert.equal(patch.patchMetadata(original,type,{}),original);assert.equal(patch.patchMetadata(original,type,{title:'Old title'}),original);
 for(const key of ['draft','slug','url','unknown'])assert.throws(()=>patch.patchMetadata(original,type,{[key]:'No'}),/not editable/);
});
for(const type of litverse)test('Distinct Litverse title-only schema '+type,()=>{
 assert.equal(METADATA_SCHEMAS[type].titleOnly,true);assert.equal(METADATA_SCHEMAS[type].themes,undefined);assert.equal(METADATA_SCHEMAS[type].hero,undefined);
 for(const key of ['date','description','themes','fragmentthemes','paintingthemes','hero','artist','year','stage'])assert.throws(()=>patch.patchMetadata(source('\n'),type,{[key]:'No'}),/not editable/);
});
const controller=readFileSync(new URL('../../assets/js/editor-test.js',import.meta.url),'utf8');
const previewSource=controller.slice(controller.indexOf('function getPreviewState('),controller.indexOf('function renderSaveStatus('));
function preview(type,overrides={}){
 const path=`content/${type}/fixed/index.md`,button={disabled:false,title:'',setAttribute(key,value){this[key]=value;}},opened=[],alerts=[];
 const context={metadataPatch:patch,URL,documentLoading:false,richEditor:{},newEssayMode:false,newEntryMode:false,documentIsLocal:true,documentPath:path,deleteBusy:false,deleteUncertain:false,saveSafety:{state:()=>({busy:false,issue:null})},pendingSave:null,saveValidationError:null,acknowledgedDiskKnown:true,savedContent:'Saved body',documentSha:'LOCAL:'+'a'.repeat(64),hasUnsavedBufferChanges:()=>false,availableDocuments:[{path:'content/people/wrong/index.md',permalink:'/wrong/'},{path,permalink:`/${type}/fixed/`}],document:{querySelector:s=>s==='.editor-actions'?{hidden:false}:s==='#save-status'?{textContent:'Saved'}:button},window:{location:{origin:'http://localhost:1313'},open:(...a)=>opened.push(a),alert:m=>alerts.push(m)},...overrides};
 const api=vm.runInNewContext(previewSource+'\n({state:getPreviewState,render:renderPreviewButton,click:previewDocument})',context);return {context,button,opened,alerts,...api};
}
for(const type of types)test('Catalog identity, local draft Preview and opener isolation '+type,()=>{
 const f=preview(type);assert.equal(f.state().url,`http://localhost:1313/${type}/fixed/`);f.render();assert.equal(f.button.disabled,false);f.click();assert.deepEqual(f.opened,[[`http://localhost:1313/${type}/fixed/`,'_blank','noopener,noreferrer']]);assert.equal(f.alerts.length,0);
});
for(const type of types)test('Dirty Preview blocks without discarding '+type,()=>{
 const f=preview(type,{hasUnsavedBufferChanges:()=>true});assert.equal(f.state().url,null);f.render();assert.equal(f.button.disabled,true);assert.match(f.button.title,/Save changes/);assert.match(f.button['aria-label'],/Save changes/);f.click();assert.equal(f.opened.length,0);assert.equal(f.context.savedContent,'Saved body');
});
for(const [name,overrides] of Object.entries({loading:{documentLoading:true},saving:{pendingSave:{}},saveBusy:{saveSafety:{state:()=>({busy:true})}},conflict:{saveSafety:{state:()=>({issue:{kind:'stale'}})}},failure:{saveValidationError:'Source mismatch'},uncertain:{acknowledgedDiskKnown:false},deleteBusy:{deleteBusy:true},deleteUncertain:{deleteUncertain:true},missingRevision:{documentSha:null}}))test('Unsafe Preview state '+name,()=>assert.equal(preview('people',overrides).state().url,null));
for(const value of [null,'','https://outside.invalid/x/','//outside.invalid/x/','javascript:alert(1)','/x?bad','/x#bad','/../x/','/%2e%2e/x/','/x\\bad','/%00x/'])test('Unsafe/missing permalink '+value,()=>{
 const f=preview('people');f.context.availableDocuments[1].permalink=value;assert.equal(f.state().url,null);f.click();assert.equal(f.opened.length,0);assert.ok(f.alerts.length);
});
test('Preview rechecks state after button was enabled',()=>{const f=preview('people');f.render();assert.equal(f.button.disabled,false);f.context.pendingSave={};f.click();assert.equal(f.opened.length,0);assert.match(f.alerts[0],/Save changes/);});
test('Preview becomes eligible after confirmed save',()=>{const f=preview('works',{hasUnsavedBufferChanges:()=>true});f.render();assert.equal(f.button.disabled,true);f.context.hasUnsavedBufferChanges=()=>false;f.render();assert.equal(f.button.disabled,false);});
test('Nested and Unicode catalog source paths remain document-bound',()=>{const f=preview('ideas');f.context.documentPath='content/ideas/nested/śāntiḥ.md';f.context.availableDocuments[1].path=f.context.documentPath;assert.equal(f.state().url,'http://localhost:1313/ideas/fixed/');});
for(const p of ['content/people/../ideas/a.md','content/people//a.md','content/other/a.md','content/people/a.md\0'])test('Unsafe source path rejected '+JSON.stringify(p),()=>assert.equal(preview('people',{documentPath:p}).state().url,null));
const apiSource=readFileSync(new URL('../../scripts/editor-api.js',import.meta.url),'utf8'),validation=apiSource.slice(apiSource.indexOf('function validateMetadataSave('),apiSource.indexOf('// Derived cards'));
for(const type of types)test('API validates exact metadata intent and Hugo URL for '+type,()=>{
 const original=source('\n').replace('hero: legacy-reference.jpg\n',''),p=`content/${type}/fixed/index.md`,revision='LOCAL:'+'a'.repeat(64),changes={title:'New title'},next=patch.patchMetadata(original,type,changes);let checks=0;
 const context={metadataPatch:patch,readLocalFile:()=>({sha:revision,content:original}),storageError:(statusCode,message)=>Object.assign(Error(message),{statusCode}),validateHeroDependency(){},metadataSourceSnapshot:()=>({files:new Map(),revisions:new Map([[p,revision]]),identity:'stable'}),metadataURL:{assertStableURL:(_files,path,content,url)=>{checks++;assert.equal(path,p);assert.equal(content,next);assert.equal(url,`/${type}/fixed/`);}}};
 const validate=vm.runInNewContext(validation+'\nvalidateMetadataSave',context),intent={changes,baseFrontmatter:patch.frontmatter(original).source,expectedPermalink:`/${type}/fixed/`};
 assert.equal(validate(p,next,revision,intent),next);assert.equal(checks,1);assert.throws(()=>validate(p,next.replace('Keep description','Changed unknown description'),revision,intent),/reviewed metadata/);
});
const {assertStableURL}=require('../../scripts/lilamaya-metadata-url.cjs');
for(const type of litverse){
 test('Authoritative Hugo Litverse title retitle preserves URL '+type,()=>{
  const path=`content/${type}/fixed/index.md`,original='---\ntitle: "Old"\ndraft: true\ncustom: keep\n---\nBody\n',next=patch.patchMetadata(original,type,{title:'New'}),files=new Map([['hugo.toml',Buffer.from('baseURL="https://example.invalid/"\n')],[path,Buffer.from(original)]]);
  assert.equal(assertStableURL(files,path,next,`/${type}/fixed/`).after,`/${type}/fixed/`);
 });
 test('URL-changing Litverse title is rejected without rewriting '+type,()=>{
  const path=`content/${type}/fixed/index.md`,original='---\ntitle: "Old"\ndraft: true\n---\nBody\n',next=patch.patchMetadata(original,type,{title:'New'}),files=new Map([['hugo.toml',Buffer.from('baseURL="https://example.invalid/"\n[permalinks]\n'+type+'="/'+type+'/:title/"\n')],[path,Buffer.from(original)]]);
  assert.throws(()=>assertStableURL(files,path,next),/would change/);assert.equal(files.get(path).toString(),original);
 });
}
