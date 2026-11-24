import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {DELETE_KINDS} from '../../assets/js/lilamaya-delete-entry.js';
const require=createRequire(import.meta.url),{TYPES}=require('../../scripts/editor-delete.js');
const source=readFileSync(new URL('../../assets/js/editor-test.js',import.meta.url),'utf8');
const declarations=source.slice(source.indexOf('let deleteView='),source.indexOf('let socialCardResult='));
function fixture(changes={}) {
 const editor={getMarkdown:()=> 'Complete नमस्ते buffer',destroy:()=>{throw Error('Must not dispose rejected draft');}};
 const context={saveSafety:{state:()=>({busy:false,issue:null,canRetry:true})},documentLoading:false,pendingSave:null,socialCardBusy:false,metadataView:null,richEditor:editor,documentIsLocal:true,acknowledgedDiskKnown:true,saveValidationError:null,hasUnsavedBufferChanges:()=>false,documentPath:'content/essays/synthetic/index.md',documentSha:'LOCAL:'+'a'.repeat(64),currentBufferIdentity:()=> 'stable',renderSaveStatus(){},...changes};
 const api=vm.runInNewContext(declarations+'\n({blocked:deletionBlocked,confirm:confirmDeletion,flags:()=>({deleteBusy,deleteUncertain})})',context);
 return {...api,context,editor};
}
for(const [type,kind] of Object.entries(TYPES))test('Shared singular label '+type,()=>assert.equal(DELETE_KINDS[type],kind));
test('Saved, safe local buffer is eligible',()=>assert.equal(fixture().blocked(),''));
for(const [name,changes] of Object.entries({loading:{documentLoading:true},savePending:{pendingSave:{}},saveBusy:{saveSafety:{state:()=>({busy:true})}},failure:{saveSafety:{state:()=>({issue:{kind:'failure'},canRetry:true})}},conflict:{saveSafety:{state:()=>({issue:{kind:'stale'},canRetry:false})}},unresolved:{acknowledgedDiskKnown:false},dirty:{hasUnsavedBufferChanges:()=>true},synchronization:{saveValidationError:'Source mismatch'},hero:{metadataView:{hasPendingHero:()=>true}},socialJob:{socialCardBusy:true},unsupportedRemote:{documentIsLocal:false}}))test('Delete blocked: '+name,()=>assert.notEqual(fixture(changes).blocked(),''));
for(const outcome of ['unchanged','uncertain','network'])test('Failure preserves complete editor buffer: '+outcome,async()=>{
 const f=fixture(),before=f.editor.getMarkdown();f.context.deletionRequest=async()=>{throw Object.assign(Error('Synthetic failure'),outcome==='network'?{}:{outcome});};
 await assert.rejects(f.confirm({path:f.context.documentPath,revision:f.context.documentSha,token:'review'},'DELETE'));
 assert.equal(f.context.richEditor,f.editor);assert.equal(f.editor.getMarkdown(),before);assert.equal(f.context.documentPath,'content/essays/synthetic/index.md');assert.equal(f.flags().deleteBusy,false);assert.equal(f.flags().deleteUncertain,outcome!=='unchanged');
 if(outcome!=='unchanged'){assert.equal(f.context.acknowledgedDiskKnown,false);assert.notEqual(f.blocked(),'');}
});
test('Changed browser buffer during move is retained for recovery, not discarded',async()=>{
 const f=fixture();f.context.deletionRequest=async()=>{f.context.currentBufferIdentity=()=> 'newer';return {deleted:true,path:f.context.documentPath,recoveryId:'synthetic'};};
 await assert.rejects(f.confirm({path:f.context.documentPath,revision:f.context.documentSha,token:'review'},'DELETE'),/draft or recovery response changed/);
 assert.equal(f.context.richEditor,f.editor);assert.equal(f.flags().deleteUncertain,true);
});
test('Old reviewed identity cannot execute',async()=>{
 const f=fixture();let requests=0;f.context.deletionRequest=async()=>{requests++;};
 await assert.rejects(f.confirm({path:'content/essays/other/index.md',revision:f.context.documentSha},'DELETE'),/revision/);assert.equal(requests,0);assert.equal(f.context.richEditor,f.editor);
});
