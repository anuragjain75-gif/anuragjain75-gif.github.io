 'use strict';
const YAML=require('js-yaml');
const lists=require('./lilamaya-theme-source.cjs');
const THEMES=Object.freeze({essays:'themes',fragments:'fragmentthemes',paintings:'paintingthemes'});
// Content-specific allowlists share the existing scalar/source patcher.
const FIELDS=Object.freeze({
 essays:['title','date','description','themes','hero'],
 fragments:['title','date','description','fragmentthemes'],
 paintings:['title','date','description','paintingthemes','hero','artist','year'],
 ...Object.fromEntries(['people','works','ideas','traditions','places','journeys'].map(type=>[type,['title']]))
});
function fail(message){throw new Error('Metadata: '+message);}
function frontmatter(source){
 if(typeof source!=='string')fail('source must be text');
 const m=source.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
 if(!m)fail('unambiguous YAML frontmatter is required');
 return {prefix:m[1],text:m[2],suffix:m[3],source:m[0],body:source.slice(m[0].length),end:m[0].length};
}
function parse(source){const fm=frontmatter(source);let data;try{data=YAML.safeLoad(fm.text)||{};}catch(e){fail('invalid or duplicate YAML keys: '+e.reason);}if(!data||Array.isArray(data)||typeof data!=='object')fail('frontmatter must be a mapping');return {...fm,data};}
function entries(fm){
 const rows=[];let offset=0;
 for(const line of fm.text.split(/(?<=\n)/)){
  const m=line.match(/^([A-Za-z_][\w-]*):([ \t]*)([^\r\n]*)/);
  if(m)rows.push({key:m[1],start:offset,valueStart:offset+m[1].length+1+m[2].length,line:m[3],lineEnd:offset+line.length});offset+=line.length;
 }
 if(new Set(rows.map(x=>x.key)).size!==rows.length||Object.keys(fm.data).some(k=>!rows.some(r=>r.key===k)))fail('unsupported or ambiguous top-level keys');
 for(let i=0;i<rows.length;i++)rows[i].end=rows[i+1]?.start??fm.text.length;
 return rows;
}
function maskQuotes(text){return text.replace(/"(?:\\.|[^"\\])*"|'(?:''|[^'])*'/g,'').replace(/(^|\s)#.*$/gm,'');}
function validateStructure(fm,rows){
 for(const row of rows){
  if(/^[|>][0-9+-]*(?:\s|$)/.test(row.line))continue;
  const content=maskQuotes(fm.text.slice(row.start,row.end));
  if(/(^|[ \t])(?:[&*!][\w!]|<<\s*:)/m.test(content))fail('aliases, anchors, tags and merges are unsupported');
 }
}
function scalar(fm,row){
 const after=fm.text.slice(row.lineEnd,row.end);
 if(after.split(/\r?\n/).some(x=>x.trim()&&!/^\s*#/.test(x)))fail('unsupported multiline syntax for '+row.key);
 let text=row.line,end=0;
 if(text[0]==='"'||text[0]==="'"){
  const quote=text[0];let closed=false;end=1;
  while(end<text.length){if(quote==='"'&&text[end]==='\\'){end+=2;continue;}if(text[end]===quote){if(quote==="'"&&text[end+1]==="'"){end+=2;continue;}end++;closed=true;break;}end++;}
  if(!closed||!/^\s*(?:#.*)?$/.test(text.slice(end)))fail('uncertain quoted scalar for '+row.key);
 }else{
  if(/^[\[\]{}&*!|>]/.test(text))fail('unsupported scalar syntax for '+row.key);
  const comment=text.search(/(?:^|\s)#/);end=(comment<0?text:text.slice(0,comment)).trimEnd().length;
 }
 return {raw:text.slice(0,end),start:row.valueStart,end:row.valueStart+end};
}
function dateString(source){const fm=parse(source),row=entries(fm).find(r=>r.key==='date');if(!row)return undefined;const {raw}=scalar(fm,row);if(raw.startsWith('"')||raw.startsWith("'"))return YAML.safeLoad('v: '+raw).v;return raw;}
function validDate(value){
 if(typeof value!=='string')return false;
 const m=value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2}))?$/);
 if(!m)return false;
 const y=+m[1],mo=+m[2],d=+m[3],date=new Date(0);date.setUTCFullYear(y,mo-1,d);date.setUTCHours(0,0,0,0);
 if(date.getUTCFullYear()!==y||date.getUTCMonth()!==mo-1||date.getUTCDate()!==d)return false;
 if(m[4]&&(+m[4]>23||+m[5]>59||+m[6]>59))return false;
 if(m[8]&&m[8]!=='Z'){const [h,mi]=m[8].slice(1).split(':').map(Number);if(h>14||mi>59||(h===14&&mi))return false;}
 return true;
}
function stable(v){return JSON.stringify(v,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)&&!(value instanceof Date)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])):value);}
function validHero(value){
 if(value===false)return 'none';
 if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&value.restoreLegacy===true)return 'legacy';
 if(typeof value==='string'&&/^images\/[a-z0-9][a-z0-9_-]{0,79}\.(?:jpg|jpeg|png|webp)$/.test(value))return 'explicit';
 fail('invalid hero association');
}
function patchMetadata(source,type,changes){
 const theme=THEMES[type];if(!Object.hasOwn(FIELDS,type))fail('unsupported content type');
 if(!changes||Array.isArray(changes)||typeof changes!=='object')fail('changes must be a mapping');
 const keys=Object.keys(changes),allowed=FIELDS[type];
 if(keys.some(k=>!allowed.includes(k)))fail('field is not editable in this stage');
 if(!keys.length)return source;
 const original=parse(source);validateStructure(original,entries(original));let result=source;
 for(const key of keys){
  const fm=parse(result),rows=entries(fm),row=rows.find(r=>r.key===key),value=changes[key],old=fm.data[key];
  if(key==='hero'){
   const restore=validHero(value)==='legacy';
   if(restore){
    if(row){const token=scalar(fm,row),line=fm.text.slice(row.start,row.lineEnd),tail=line.slice(token.end-row.start);const comment=tail.match(/#[^\r\n]*/)?.[0];const ending=line.match(/\r?\n$/)?.[0]||'';
     const start=!comment&&!ending&&row.start>0?row.start-(fm.text.slice(0,row.start).endsWith('\r\n')?2:1):row.start;
     result=result.slice(0,fm.prefix.length+start)+(comment?comment+ending:'')+result.slice(fm.prefix.length+row.lineEnd);}
   }else if(old!==value){
    if(row){const token=scalar(fm,row);result=result.slice(0,fm.prefix.length+token.start)+(value===false?'false':JSON.stringify(value))+result.slice(fm.prefix.length+token.end);}
    else result=insert(fm,key,value===false?'false':JSON.stringify(value));
   }
   continue;
  }
  if(key===theme){
   if(!Array.isArray(value)||value.some(v=>typeof v!=='string'||!v.trim()||v!==v.trim()||v.length>100||/[\x00-\x1f\x7f]/.test(v)))fail('invalid theme assignments');
   if(new Set(value.map(v=>v.toLowerCase())).size!==value.length)fail('duplicate theme assignments');
   if(old!==undefined&&(!Array.isArray(old)||old.some(v=>typeof v!=='string')))fail('existing theme assignments are unsupported');
   if(old&&old.length===value.length&&old.every(v=>value.includes(v)))continue;
   if(row){const add=value.filter(v=>!old.includes(v));result=lists.rewriteList(result,key,v=>value.includes(v)?v:null,true);if(add.length)result=lists.rewriteList(result,key,v=>v,true,add);}
   else if(value.length)result=insert(fm,key,'['+value.map(v=>JSON.stringify(v)).join(', ')+']');
   continue;
  }
  if(typeof value!=='string'||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))fail('invalid text for '+key);
  const previous=key==='date'?dateString(result):old;
  if((key==='year'?String(previous):previous)===value)continue;
  if(key==='date'&&!validDate(value))fail('date must be YYYY-MM-DD or a complete ISO timestamp with timezone');
  if((key==='title'||key==='artist')&&(!value.trim()||value.length>1000))fail(key+' must be nonempty text (at most 1000 characters)');
  if(key==='year'&&!/^\d{4}$/.test(value))fail('painting year must contain four digits');
  if(key==='year'&&old!==undefined&&!['string','number'].includes(typeof old))fail('existing year type is unsupported');
  if(!row&&value==='')continue;
  let encoded;
  if(row){
   const token=scalar(fm,row);
   if(key==='year'&&typeof old==='number')encoded=String(Number(value));
   else if(key==='date'&&!/^["']/.test(token.raw))encoded=value;
   else if(token.raw.startsWith("'")&&!/[\r\n]/.test(value))encoded="'"+value.replace(/'/g,"''")+"'";
   else if(!token.raw.startsWith('"')&&!/[\r\n:#\[\]{},&*!|>'"\\]/.test(value)){
    try{encoded=YAML.safeLoad('v: '+value).v===value?value:JSON.stringify(value);}catch{encoded=JSON.stringify(value);}
   }else encoded=JSON.stringify(value);
   result=result.slice(0,fm.prefix.length+token.start)+encoded+result.slice(fm.prefix.length+token.end);
  }else result=insert(fm,key,JSON.stringify(value));
 }
 const checked=parse(result);
 for(const key of keys){
  const desired=changes[key],actual=key==='date'?dateString(result):checked.data[key];
  if(key==='hero'&&validHero(desired)==='legacy'&&actual===undefined)continue;
  if(actual===undefined&&((typeof desired==='string'&&desired==='')||(Array.isArray(desired)&&!desired.length)))continue;
  if(key===theme){if(!Array.isArray(actual)||actual.length!==desired.length||!actual.every(v=>desired.includes(v)))fail('theme patch validation failed');}
  else if(key==='year'){if(String(actual)!==desired)fail('year representation cannot be preserved');}
  else if(actual!==desired)fail('scalar patch validation failed for '+key);
 }
 const unchanged=obj=>Object.fromEntries(Object.entries(obj).filter(([k])=>!keys.includes(k)));
 if(stable(unchanged(original.data))!==stable(unchanged(checked.data))||checked.body!==original.body)fail('unrelated metadata or body changed');
 return result;
}
function insert(fm,key,value){const styles=[...new Set(fm.source.match(/\r\n|\n|\r/g)||[])];if(styles.length!==1||styles[0]==='\r')fail('cannot safely infer frontmatter line endings');return fm.prefix+fm.text+styles[0]+key+': '+value+fm.suffix+fm.body;}
function urlFields(source){const fm=parse(source);return {title:fm.data.title,date:dateString(source)};}
module.exports={validHero,THEMES,FIELDS,frontmatter,parse,patchMetadata,validDate,dateString,urlFields,stable};
