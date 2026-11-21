import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {Schema} from '@milkdown/kit/prose/model';
const source=fs.readFileSync('assets/js/lilamaya-rich-editor.js','utf8');
const start=source.indexOf('  function isZeroByteImagePlaceholder('),end=source.indexOf('  function createImageInsertionCallback()',start);
assert.ok(start>=0&&end>start);
const parserKey={};
const schema=new Schema({nodes:{doc:{content:'block+'},paragraph:{group:'block',content:'text*',attrs:{provenance:{default:null}}},text:{group:'inline'}}});
const empty=()=>schema.nodes.doc.create(null,[schema.nodes.paragraph.create()]);
function fixture(text='\r\n',kind='poetry'){
 const map={sourceLength:text.length,blocks:[],inlineNodes:[]};
 const segment={type:'markdown',content:text},protectedSegment={type:kind,content:'protected bytes'};
 const r={segment,segmentIndex:1,originalSource:text,originalSourceMap:null,originalDoc:empty(),crepe:{lilamayaSourceMap:[map],lilamayaGeneratedTrailingParagraphs:new WeakSet()},view:{state:{doc:empty()}}};
 const segments=[protectedSegment,segment];const state={parserResult:null,collector:'once'};
 const parser=()=>{if(state.collector!=='none')r.crepe.lilamayaSourceMap.push({...map,blocks:[...map.blocks],inlineNodes:[...map.inlineNodes]});if(state.collector==='twice')r.crepe.lilamayaSourceMap.push({...map});return state.parserResult||empty()};
 r.crepe.editor={action(fn){fn({get(key){assert.equal(key,parserKey);return parser}})}};
 const ctx=vm.createContext({segments,activeEditor:{},parserCtx:parserKey,getEditorView:()=>r.view,isGeneratedTrailingCursor:()=>false,captureOriginalSourceMap:()=>null});
 const api=vm.runInContext(source.slice(start,end)+'\n({proof:isWhitespaceStructuralImageSource,capture:captureImageSourceBaseline,zero:isZeroByteImagePlaceholder})',ctx);
 return {r,map,segments,state,api,ctx,proof:()=>api.proof(r,text,r.view.state.doc,state.parserResult||empty(),map)};
}
for(const kind of ['introduction','poetry','invocation'])for(const text of ['\n','\r\n',' \t\n\n',' \t\r\n\r\n','  ','\t'])test('Preserve nonzero '+kind+' whitespace '+JSON.stringify(text),()=>{
 const f=fixture(text,kind),before=f.r.segment.content;assert.equal(f.proof(),true);const b=f.api.capture(f.r);assert.equal(b.whitespaceStructural,true);assert.equal(b.emptyPlaceholder,undefined);assert.equal(b.source,before);assert.equal(b.map.sourceLength,text.length);assert.equal(b.map.blocks.length,0);assert.ok(Object.isFrozen(b)&&Object.isFrozen(b.map));assert.equal(f.r.originalSource,before);assert.equal(f.r.segment.content,before);assert.equal(f.r.originalSourceMap,null);
});
for(const text of ['', '\n\r\n','\r','\u00a0','\ufeff','<!-- hidden -->','<br />','text','{{< poetry >}}',' नमस्ते '])test('Reject structural classification '+JSON.stringify(text),()=>assert.equal(fixture(text).proof(),false));
for(const [name,change] of [
 ['source changed',f=>f.r.segment.content+=' '],['opening bytes changed',f=>f.r.originalSource+=' '],['source-backed original map',f=>f.r.originalSourceMap={}],['nonterminal segment',f=>f.segments.push({type:'markdown',content:'other'})],['stale index',f=>f.r.segmentIndex=0],['unmounted segment',f=>f.segments.pop()],['preceding Markdown',f=>f.segments[0].type='markdown'],['unsupported protected type',f=>f.segments[0].type='unknown'],['wrong source length',f=>f.map.sourceLength++],['mapped source block',f=>f.map.blocks.push({start:0,end:1})],['inline content',f=>f.map.inlineNodes.push({})],['missing original map',f=>f.r.crepe.lilamayaSourceMap=[]],['original text',f=>f.r.originalDoc=schema.nodes.doc.create(null,[schema.nodes.paragraph.create(null,schema.text('original'))])],['live text',f=>f.r.view.state.doc=schema.nodes.doc.create(null,[schema.nodes.paragraph.create(null,schema.text('changed'))])],['authored additional paragraph',f=>f.r.view.state.doc=schema.nodes.doc.create(null,[schema.nodes.paragraph.create(),schema.nodes.paragraph.create()])],['explicit paragraph attribute',f=>f.r.view.state.doc=schema.nodes.doc.create(null,[schema.nodes.paragraph.create({provenance:'authored'})])],['parsed mismatch',f=>f.state.parserResult=schema.nodes.doc.create(null,[schema.nodes.paragraph.create(null,schema.text('parse mismatch'))])]
])test('Reject stale/ambiguous '+name,()=>{const f=fixture();change(f);assert.equal(f.proof(),false)});
for(const collector of ['none','twice'])test('Capture rejects collector '+collector,()=>{const f=fixture();f.state.collector=collector;assert.throws(()=>f.api.capture(f.r),/Cannot safely insert image/)});
test('Structural writing space cannot become active image target',()=>{const f=fixture();f.ctx.activeEditor=f.r;assert.throws(()=>f.api.capture(f.r),/no mapped image insertion boundary/)});
test('Proof detects source modification while picker is open',()=>{const f=fixture();const b=f.api.capture(f.r);f.r.segment.content+=' ';assert.equal(f.api.proof(f.r,b.source,f.r.view.state.doc,b.parsed,b.map),false)});
test('Proof detects editor modification while picker is open',()=>{const f=fixture();const b=f.api.capture(f.r);f.r.view.state.doc=schema.nodes.doc.create(null,[schema.nodes.paragraph.create(null,schema.text('new draft'))]);assert.equal(f.api.proof(f.r,b.source,f.r.view.state.doc,b.parsed,b.map),false)});
test('Zero-byte placeholders remain separately classified',()=>{const f=fixture('');const b=f.api.capture(f.r);assert.equal(b.emptyPlaceholder,true);assert.equal(b.whitespaceStructural,undefined);assert.equal(b.map.sourceLength,0)});
