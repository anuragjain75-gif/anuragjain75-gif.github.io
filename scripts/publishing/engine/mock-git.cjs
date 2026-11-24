'use strict';
// Git-format objects in memory/JSON ONLY. No git executable, repository or real commit.
const crypto=require('node:crypto');
const oid=(type,bytes)=>crypto.createHash('sha1').update(Buffer.from(type+' '+bytes.length+'\0')).update(bytes).digest('hex');
function safe(p){
 if(typeof p!=='string'||!p||p.startsWith('/')||/[\\\x00-\x1f\x7f%?#:]/.test(p)||p.split('/').some((x,i,parts)=>!x||x==='.'||x==='..'||x.toLowerCase()==='.git'||(x.startsWith('.')&&!['.github','.gitignore'].includes(x)&&!(i===0&&parts.length===1&&x==='.hugo_build.lock'))))throw new Error('Unsafe remote path');
 return p;
}
function object(type,bytes,objects){const id=oid(type,bytes);objects[id]={type,data:bytes.toString('base64')};return id;}
function buildTree(files){
 const root={children:new Map()},objects={};
 for(const [p,input] of Object.entries(files).sort()){
  safe(p);const parts=p.split('/');let node=root;
  for(const name of parts.slice(0,-1)){if(node.file)throw new Error('Duplicate destination');if(!node.children.has(name))node.children.set(name,{children:new Map()});node=node.children.get(name);}
  const name=parts.at(-1);if(node.file)throw new Error('File/directory collision');if(node.children.has(name))throw new Error('Duplicate destination');
  const bytes=Buffer.isBuffer(input)?input:input.bytes,mode=Buffer.isBuffer(input)?'100644':input.mode;
  if(!Buffer.isBuffer(bytes)||!['100644','100755'].includes(mode))throw new Error('Unsafe Git mode');node.children.set(name,{file:true,mode,bytes});
 }
 function encode(node){
  if(node.file)throw new Error('File/directory collision');
  const entries=[...node.children].sort(([a,x],[b,y])=>Buffer.compare(Buffer.from(a+(x.file?'':'/')),Buffer.from(b+(y.file?'':'/'))));
  return object('tree',Buffer.concat(entries.map(([name,n])=>{const mode=n.file?n.mode:'40000',id=n.file?object('blob',n.bytes,objects):encode(n);return Buffer.concat([Buffer.from(mode+' '+name+'\0'),Buffer.from(id,'hex')]);})),objects);
 }
 return {tree:encode(root),objects};
}
function mockRemote(files,generation='0'){
 const {tree,objects}=buildTree(files),data=Buffer.from(`tree ${tree}\nauthor Synthetic <synthetic@invalid> 1794873600 +0000\ncommitter Synthetic <synthetic@invalid> 1794873600 +0000\n\nSynthetic fixture ${generation}\n`);
 const commit=object('commit',data,objects);return {kind:'synthetic-git',ref:{name:'refs/heads/main',oid:commit},objects};
}
function readRemote(remote){
 if(!remote||!['synthetic-git','github-snapshot'].includes(remote.kind)||remote.ref?.name!=='refs/heads/main'||!/^[a-f0-9]{40}$/.test(remote.ref.oid)||!remote.objects||Object.keys(remote.objects).length>20000)throw new Error('Invalid mocked remote reference');
 let total=0;
 function get(id,type){
  const x=remote.objects[id];if(!x||x.type!==type||typeof x.data!=='string')throw new Error('Missing or wrong Git object');const b=Buffer.from(x.data,'base64');
  if(b.length>20*1024*1024||b.toString('base64')!==x.data||oid(type,b)!==id)throw new Error('Corrupt Git object');total+=b.length;if(total>200*1024*1024)throw new Error('Mock tree size limit');return b;
 }
 const trees=remote.kind==='github-snapshot'?(()=>{const c=remote.commitRecord;if(c?.sha!==remote.ref.oid||!/^([a-f0-9]{40})$/.test(c.tree?.sha||''))throw Error('Invalid provider commit/tree attestation');return ['tree '+c.tree.sha];})():(()=>{const commit=get(remote.ref.oid,'commit').toString('utf8'),headers=commit.split('\n\n')[0].split('\n'),trees=headers.filter(x=>x.startsWith('tree '));
 if(trees.length!==1||!/^tree [a-f0-9]{40}$/.test(trees[0]))throw new Error('Ambiguous commit tree');
 return trees;})();
 const tree=trees[0].slice(5),files={},modes={},blobOids={};
 function walk(id,prefix,stack){
  if(stack.has(id)||stack.size>32)throw new Error('Tree cycle/depth');const next=new Set(stack);next.add(id);const b=get(id,'tree');let at=0;const seen=new Set();
  while(at<b.length){const space=b.indexOf(32,at),zero=b.indexOf(0,space+1);if(space<0||zero<0||zero+21>b.length)throw new Error('Malformed Git tree');
   const mode=b.toString('ascii',at,space),name=new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(space+1,zero)),child=b.subarray(zero+1,zero+21).toString('hex');at=zero+21;
   if(name.includes('/')||seen.has(name))throw new Error('Duplicate tree destination');seen.add(name);const p=safe(prefix+name);
   if(mode==='40000')walk(child,p+'/',next);
   else{if(!['100644','100755'].includes(mode))throw new Error('Unsafe Git mode (symlink/submodule)');if(Object.hasOwn(files,p))throw new Error('Duplicate tree destination');files[p]=get(child,'blob');modes[p]=mode;blobOids[p]=child;}
  }
 }
 walk(tree,'',new Set());return {parent:remote.ref.oid,tree,files,modes,blobOids};
}
module.exports={oid,safe,buildTree,mockRemote,readRemote};
