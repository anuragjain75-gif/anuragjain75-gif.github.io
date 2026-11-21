'use strict';
// Same installed YAML parser, without the Node-only gray-matter wrapper.
const yaml = text => require('js-yaml').safeLoad(text) || {};
class ThemeValidationError extends Error { constructor(message) { super(message); this.name='ThemeValidationError'; this.statusCode=400; } }
const keyOf = name => name.toLowerCase();
function label(name) { const [first,...rest]=Array.from(name); return first ? first.toUpperCase()+rest.join('') : name; }
function validName(value) {
  if(typeof value!=='string'||!value.trim()||value.trim().length>100||/[\x00-\x1f\x7f]/.test(value))throw new ThemeValidationError('Theme names must contain 1–100 printable characters');
  return value.trim();
}
function scalar(raw) {
  if(!raw || /^[&*!|>]/.test(raw))throw new ThemeValidationError('Unsupported theme scalar');
  const value=yaml('value: '+raw).value;
  if(typeof value!=='string'||value!==value.trim())throw new ThemeValidationError('Theme names must be plain or quoted strings without outer whitespace');
  validName(value);return value;
}
function token(text,position) {
  let i=position;while(/[ \t]/.test(text[i]||'')&&i<text.length)i++;
  const start=i;let raw;
  if(text[i]==='"'||text[i]==="'") {
    const quote=text[i++];let closed=false;
    while(i<text.length){if(quote==='"'&&text[i]==='\\'){i+=2;continue;}if(text[i]===quote){if(quote==="'"&&text[i+1]==="'"){i+=2;continue;}i++;closed=true;break;}i++;}
    if(!closed)throw new ThemeValidationError('Unterminated theme string');raw=text.slice(start,i);
  } else {
    while(i<text.length&&!/[\r\n,\]#]/.test(text[i]))i++;
    raw=text.slice(start,i).trimEnd();i=start+raw.length;
    if(/[\[{}&*!|>'"\\]/.test(raw))throw new ThemeValidationError('Unsupported theme scalar');
  }
  return {start,end:i,raw,value:scalar(raw)};
}
function listInfo(source,key,frontmatter=true) {
  if(!/^[A-Za-z]+$/.test(key))throw new ThemeValidationError('Invalid theme field');
  let text=source,offset=0;
  if(frontmatter){const fm=source.match(/^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/);if(!fm)throw new ThemeValidationError('YAML frontmatter required');text=fm[2];offset=fm[1].length;}
  const data=yaml(text),values=data[key];if(!Array.isArray(values)||values.some(v=>typeof v!=='string'))throw new ThemeValidationError(key+' must be a list of strings');
  values.forEach(validName);
  const lines=[];let at=0;for(const line of text.match(/[^\r\n]*(?:\r\n|\n|$)/g)||[]){if(!line)continue;lines.push({text:line,start:at,end:at+line.length});at+=line.length;}
  const matches=lines.map((line,index)=>({line,index,m:line.text.match(new RegExp('^'+key+':[ \\t]*(.*?)(?:\\r?\\n)?$'))})).filter(x=>x.m);
  if(matches.length!==1)throw new ThemeValidationError('A unique top-level '+key+' field is required');
  const {line,index,m}=matches[0],headEnd=line.start+line.text.indexOf(':')+1;
  let end=text.length;for(const l of lines.slice(index+1)){if(/^[^\s#-]/.test(l.text)){end=l.start;break;}}
  const first=text.slice(headEnd,line.end).trim(),tokens=[];let flow=false,close=-1;
  if(first.startsWith('[')) {
    flow=true;let pos=headEnd;while(/[ \t]/.test(text[pos]))pos++;pos++;
    while(true){while(/[ \t]/.test(text[pos]))pos++;if(text[pos]===']'){close=pos;break;}if(pos>=line.end)throw new ThemeValidationError('Only single-line flow theme lists are supported');const t=token(text,pos);tokens.push(t);pos=t.end;while(/[ \t]/.test(text[pos]))pos++;if(text[pos]===']'){close=pos;break;}if(text[pos]!==',')throw new ThemeValidationError('Malformed theme list');pos++;}
    if(!/^[ \t]*(?:#[^\r\n]*)?\r?\n?$/.test(text.slice(close+1,line.end)))throw new ThemeValidationError('Unexpected theme-list suffix');
    if(text.slice(line.end,end).trim()&&!/^\s*#/.test(text.slice(line.end,end)))throw new ThemeValidationError('Unexpected theme-list continuation');
  } else {
    if(first&&!first.startsWith('#'))throw new ThemeValidationError('Unsupported theme list representation');
    for(const l of lines.slice(index+1).filter(l=>l.start<end)){
      if(/^[ \t]*(?:#[^\r\n]*)?\r?\n?$/.test(l.text))continue;
      const prefix=l.text.match(/^([ \t]*-[ \t]+)/);if(!prefix)throw new ThemeValidationError('Unsupported block theme item');
      const t=token(text,l.start+prefix[0].length),suffix=text.slice(t.end,l.end);
      if(!/^[ \t]*(?:#[^\r\n]*)?\r?\n?$/.test(suffix))throw new ThemeValidationError('Unsupported theme item suffix');
      tokens.push({...t,itemStart:l.start,itemEnd:l.end,indent:prefix[1].replace(/-[ \t]+$/,''),eol:l.text.endsWith('\r\n')?'\r\n':l.text.endsWith('\n')?'\n':'',comment:suffix.match(/#[^\r\n]*/)?.[0]||''});
    }
  }
  if(JSON.stringify(tokens.map(t=>t.value))!==JSON.stringify(values))throw new ThemeValidationError('Theme tokens do not correspond exactly to parsed metadata');
  return {text,offset,values,tokens,flow,close,start:line.start,end,headEnd,data};
}
function encode(value,raw='""') {
  validName(value);
  if(raw.startsWith("'"))return "'"+value.replace(/'/g,"''")+"'";
  if(!raw.startsWith('"')&&!/[\[\]{},#&*!|>'"\\\r\n]/.test(value)){try{if(scalar(value)===value)return value;}catch{}}
  return JSON.stringify(value);
}
function rewriteList(source,key,change,frontmatter=true,append=[]) {
  const info=listInfo(source,key,frontmatter),{tokens,text,offset}=info;const edits=[],values=[];
  for(let n=0;n<tokens.length;n++){
    const t=tokens[n],next=change(t.value,n);
    if(next===null){
      if(info.flow){if(n<tokens.length-1)edits.push({start:t.start,end:tokens[n+1].start,value:''});else if(n>0)edits.push({start:tokens[n-1].end,end:t.end,value:''});else edits.push({start:t.start,end:t.end,value:''});}
      else edits.push({start:t.itemStart,end:t.itemEnd,value:t.comment?t.indent+t.comment+t.eol:''});
    }else{validName(next);values.push(next);if(next!==t.value)edits.push({start:t.start,end:t.end,value:encode(next,t.raw)});}
  }
  if(append.length){
    append.forEach(validName);values.push(...append);
    if(info.flow){const last=tokens.at(-1);edits.push({start:last?.end||info.close,end:last?.end||info.close,value:(tokens.length?', ':'')+append.map(x=>JSON.stringify(x)).join(', ')});}
    else{
      const styles=[...new Set(text.match(/\r\n|\r|\n/g)||[])];if(styles.length!==1||styles[0]==='\r')throw new ThemeValidationError('Cannot infer catalog line ending');
      const last=tokens.at(-1);if(!last)throw new ThemeValidationError('An empty list must use []');const eol=styles[0];edits.push({start:last.itemEnd,end:last.itemEnd,value:(last.eol?'':eol)+append.map(x=>(last.indent||'')+'- '+JSON.stringify(x)).join(eol)+(last.eol?eol:'')});
    }
  }
  if(!values.length&&!info.flow){edits.push({start:info.headEnd,end:info.headEnd,value:' []'});}
  // Adjacent removals are merged, but never allow a replacement to be swallowed.
  edits.sort((a,b)=>a.start-b.start||a.end-b.end);const merged=[];
  for(const e of edits){const prev=merged.at(-1);if(prev&&e.start<prev.end){if(prev.value||e.value)throw new ThemeValidationError('Ambiguous overlapping theme changes');prev.end=Math.max(prev.end,e.end);}else merged.push({...e});}
  let result=text;for(const e of merged.reverse())result=result.slice(0,e.start)+e.value+result.slice(e.end);
  const updated=source.slice(0,offset)+result+source.slice(offset+text.length);const checked=listInfo(updated,key,frontmatter);
  if(JSON.stringify(checked.values)!==JSON.stringify(values))throw new ThemeValidationError('Theme rewrite failed exact metadata validation');
  const without=(obj)=>Object.fromEntries(Object.entries(obj).filter(([k])=>k!==key));if(JSON.stringify(without(info.data))!==JSON.stringify(without(checked.data)))throw new ThemeValidationError('Unrelated metadata changed');
  return updated;
}
module.exports={label,keyOf,validName,listInfo,rewriteList};
