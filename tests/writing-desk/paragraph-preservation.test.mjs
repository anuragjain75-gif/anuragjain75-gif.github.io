import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {Schema} from "@milkdown/kit/prose/model";
import {SerializerState} from "@milkdown/kit/transformer";
import {applySourceReplacements} from "../../assets/js/lilamaya-source-sync.js";
import {parseHugoDocument} from "../../assets/js/lilamaya-document.js";
const source = fs.readFileSync("assets/js/lilamaya-rich-editor.js", "utf8");
const parserCtx = {}, schemaCtx = {}, remarkCtx = {}, headingIdGenerator = {key:{}};
function extract(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
const capture = extract("function captureOriginalSourceMap(", "function diagnoseProseMirrorInlineFormatting(");
const whitespace = extract("  function synchronizeParagraphWhitespace(", "  function verifyIntentionalEmptyInsertion(");
const cursor = extract("function isGeneratedTrailingCursor(", "function sourceBackedBaselineDocument(");
const append = extract("  function singleBlockAppend(", "  function synchronizeParagraphConversion(");
const authoredSerializer = extract("  function serializeAuthoredParagraphRegion(", "  function singleBlockAppend(");
const context = {parserCtx, schemaCtx, remarkCtx, SerializerState, headingIdGenerator, applySourceReplacements, parseHugoDocument,
  console:{error(){}}};
const helpers = vm.runInNewContext(capture + whitespace + cursor + authoredSerializer + append +
  "\n({whitespace:synchronizeParagraphWhitespace, cursor:isGeneratedTrailingCursor, append:singleBlockAppend,serialize:serializeAuthoredParagraphRegion})", context);
const schema = new Schema({nodes:{doc:{content:"block+"}, paragraph:{group:"block",content:"inline*"},
  text:{group:"inline"}, hardbreak:{group:"inline",inline:true,attrs:{isInline:{default:false}}}}, marks:{strong:{}}});
const paragraph = value => schema.nodes.paragraph.create(null,value ? schema.text(value) : null);
function fixture({eol="\n", marker=null, terminal="  "}={}) {
  const first="First.", second="Second.";
  const content = [schema.text(first)];
  if(marker!==null)content.push(schema.nodes.hardbreak.create(),schema.text(second));
  const original = schema.nodes.paragraph.create(null,content);
  const edited = schema.nodes.paragraph.create(null,[schema.text(first+" Edited."),...content.slice(1)]);
  const text = first + (marker===null ? "" : marker+eol+second) + terminal + eol;
  const expected = text.replace(first,first+" Edited.");
  const block={type:"paragraph",depth:1,start:0,end:text.length-eol.length,source:text.slice(0,-eol.length).slice(0,220)};
  const spans=[{type:"text",parentBlock:"paragraph",parentStart:0,start:0,end:first.length,value:first,source:first}];
  if(marker!==null){const start=first.length+marker.length+eol.length;spans.push({type:"text",parentBlock:"paragraph",parentStart:0,start,end:start+second.length,value:second,source:second});}
  const doc=schema.nodes.doc.create(null,[original]), next=schema.nodes.doc.create(null,[edited]);
  const map={sourceLength:text.length,blocks:[block],inlineNodes:spans};
  const record={originalSource:text,originalDoc:doc,originalSourceMap:map,crepe:{editor:{action(fn){fn({get(key){assert.equal(key,parserCtx);return value=>{if(value===text)return doc;if(value===expected)return next;throw Error("unexpected proposed source");}}});}}}};
  return {record,original,edited,block,text,expected};
}
for(const eol of ["\n","\r\n"])for(const marker of [null,"  ","\\"])for(const terminal of ["","  ","   ","\t"]){
  if(marker===null&&!terminal)continue;
  test(`Preserve exact sensitive bytes ${JSON.stringify({eol,marker,terminal})}`,()=>{
    const f=fixture({eol,marker,terminal}), before=JSON.stringify(f.record.originalSourceMap);
    const replacement=helpers.whitespace(f.record,0,f.original,f.edited,f.block);
    assert.equal(applySourceReplacements(f.text,[replacement]),f.expected);
    assert.equal(JSON.stringify(f.record.originalSourceMap),before);
  });
}
test("Ordinary paragraphs keep the established path",()=>{
  const f=fixture({terminal:""});assert.equal(helpers.whitespace(f.record,0,f.original,f.edited,f.block),null);
});
for(const [name,mutate] of [
  ["stale excerpt",f=>f.record.originalSourceMap.inlineNodes[0].source="wrong"],
  ["wrong offset",f=>f.record.originalSourceMap.inlineNodes[0].start=1],
  ["missing text map",f=>f.record.originalSourceMap.inlineNodes=[]],
  ["changed marks",f=>f.edited=schema.nodes.paragraph.create(null,schema.text("Edited",[schema.marks.strong.create()]))],
  ["changed structure",f=>f.edited=schema.nodes.paragraph.create(null,[schema.text("Edited"),schema.nodes.hardbreak.create()])],
  ["parse mismatch",f=>f.record.crepe.editor.action=fn=>fn({get(){return()=>f.record.originalDoc;}})]
])test("Reject uncertain sensitive edit: "+name,()=>{const f=fixture();mutate(f);assert.throws(()=>helpers.whitespace(f.record,0,f.original,f.edited,f.block));assert.equal(f.record.originalSource,f.text);});
const empty=paragraph(""), text=paragraph("After.");
test("Only a unique tracked empty trailing cursor may be projected",()=>assert.equal(helpers.cursor([text,empty],new WeakSet([empty])),true));
test("Never project an untracked authored empty paragraph",()=>assert.equal(helpers.cursor([text,empty],new WeakSet()),false));
test("Never project source-backed whitespace nodes",()=>assert.equal(helpers.cursor([text,empty],new WeakSet([empty]),[empty]),false));
test("Never project a tracked node appearing multiple times",()=>assert.equal(helpers.cursor([text,empty,empty],new WeakSet([empty])),false));
test("Never project an intermediate tracked paragraph",()=>assert.equal(helpers.cursor([empty,text],new WeakSet([empty])),false));
test("Never project a tracked node containing text",()=>assert.equal(helpers.cursor([text],new WeakSet([text])),false));
for(const eol of ["\n","\r\n"])for(const count of [1,2,3])test(`Guarded exact append with ${count} authored gaps ${JSON.stringify(eol)}`,()=>{
  const original=paragraph("Before."), nodes=[original,...Array(count).fill(empty),text];
  const old="Before."+eol, added=Array(count).fill("<br />").concat("After.").join("\n\n")+"\n";
  const expected="Before."+eol+eol+added.replace(/\n$/," ").trimEnd().replace(/\n/g,eol)+eol;
  const doc=schema.nodes.doc.create(null,[original]),next=schema.nodes.doc.create(null,nodes);
  const map={sourceLength:old.length,blocks:[{type:"paragraph",depth:1,start:0,end:7,source:"Before."}],inlineNodes:[]};
  const record={originalSource:old,originalDoc:doc,originalSourceMap:map,crepe:{editor:{action(fn){fn({get(key){if(key===schemaCtx)return schema;if(key===parserCtx)return value=>value===expected?next:doc;throw Error("unexpected context");}});}}}};
  const plan={anchors:[{originalIndex:0,currentIndex:0}],regions:[{originalStart:1,originalEnd:1,currentStart:1,currentEnd:nodes.length}]};
  assert.equal(helpers.append(record,[original],nodes,plan,[added]),expected);
  assert.equal(record.originalSource,old);
});

const serializationSchema = new Schema({nodes:{
 doc:{content:"block+",toMarkdown:{match:n=>n.type.name==="doc",runner(){throw Error("Must not invoke upstream doc trimming")}}},
 paragraph:{group:"block",content:"inline*",toMarkdown:{match:n=>n.type.name==="paragraph",runner(state,node){state.openNode("paragraph");if(!node.content.size)state.addNode("html",undefined,"<br />");else state.next(node.content);state.closeNode()}}},
 text:{group:"inline",toMarkdown:{match:n=>n.isText,runner(state,node){state.addNode("text",undefined,node.text)}}}
}});
for(const count of [1,2])test(`Serializer state retains ${count} final authored empty paragraphs`,()=>{
 const nodes=Array.from({length:count},()=>serializationSchema.nodes.paragraph.create());
 const ctx={get(key){if(key===schemaCtx)return serializationSchema;if(key===remarkCtx)return {stringify:tree=>JSON.stringify(tree)};throw Error("Unknown service")}};
 const ast=JSON.parse(helpers.serialize(ctx,nodes));assert.equal(ast.type,"root");assert.equal(ast.children.length,count);
 for(const paragraph of ast.children)assert.equal(paragraph.children[0].value,"<br />");
});
