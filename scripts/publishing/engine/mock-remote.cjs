'use strict';
const {hash,internals:{canonical}}=require('./editor-publish.cjs');
const {oid,readRemote,buildTree}=require('./mock-git.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
function operationId(t){return hash(canonical({version:5,planId:t.planId,foundationId:t.foundationId,parent:t.parent,tree:t.tree}));}
function publicationCommit(t){if(t.committer){const a=t.committer;if(typeof a.name!=='string'||typeof a.email!=='string'||/[\r\n<>]/.test(a.name+a.email)||!Number.isSafeInteger(a.time)||typeof t.message!=='string'||/[\r\n]/.test(t.message))throw Error('Invalid publication author');return Buffer.from(`tree ${t.tree}\nparent ${t.parent}\nauthor ${a.name} <${a.email}> ${a.time} +0000\ncommitter ${a.name} <${a.email}> ${a.time} +0000\n\n${t.message}\noperation ${t.operationId}\n`);}return Buffer.from(`tree ${t.tree}\nparent ${t.parent}\nauthor Synthetic Publisher <mock@invalid> 1794873600 +0000\ncommitter Synthetic Publisher <mock@invalid> 1794873600 +0000\n\nLilamaya mock operation ${t.operationId}\nplan ${t.planId}\n`);}
function sealTx(input){const tx=clone(input);delete tx.digest;tx.digest=hash(canonical(tx));return tx;}
function verifyTx(t){const x=clone(t);delete x.digest;if(t.version!==5||t.operationId!==operationId(t)||t.digest!==hash(canonical(x))||oid('commit',publicationCommit(t))!==t.commit)throw new Error('Tampered transaction identity/payload');
 for(const [id,o]of Object.entries(t.objects)){const b=Buffer.from(o.data,'base64');if(b.toString('base64')!==o.data||oid(o.type,b)!==id)throw new Error('Tampered transaction object');}
 if(!t.objects[t.commit]||t.objects[t.commit].data!==publicationCommit(t).toString('base64'))throw new Error('Wrong intended commit');return true;}
function commitInfo(objects,id){const o=objects[id];if(!o||o.type!=='commit')throw new Error('Missing commit proof');const b=Buffer.from(o.data,'base64');if(oid('commit',b)!==id||b.toString('base64')!==o.data)throw new Error('Corrupt commit proof');const lines=b.toString('utf8').split('\n\n')[0].split('\n'),ts=lines.filter(x=>x.startsWith('tree '));if(ts.length!==1)throw new Error('Ambiguous commit proof');const parents=lines.filter(x=>x.startsWith('parent ')).map(x=>x.slice(7));if(parents.length>1||parents.some(p=>!/^[a-f0-9]{40}$/.test(p)))throw new Error('Unsupported commit ancestry');return {tree:ts[0].slice(5),parents};}
function ancestor(objects,head,wanted){let at=head;const seen=new Set();for(let n=0;n<1000;n++){if(at===wanted){commitInfo(objects,at);return true;}if(seen.has(at))throw new Error('Cyclic ancestry');seen.add(at);const c=commitInfo(objects,at);if(!c.parents.length)return false;at=c.parents[0];}throw new Error('Ancestry proof limit');}
class MockRemote {
 constructor(remote){readRemote(remote);this.remote=clone(remote);this.receipts={};this.deployments={};this.log=[];this.unreadable=false;this.hideReceipt=false;}
 observe(operation){if(this.unreadable)throw new Error('Mock reference unavailable');readRemote(this.remote);return {remote:clone(this.remote),receipt:this.hideReceipt?null:clone(this.receipts[operation]||null)};}
 compareAndSwap(tx){verifyTx(tx);this.log.push({type:'CAS_CALL',operationId:tx.operationId,parent:this.remote.ref.oid});
  if(this.receipts[tx.operationId]){const old=this.receipts[tx.operationId];if(old.digest!==tx.digest)throw new Error('Operation ID reused with different result');return clone(old);}
  const candidate={...clone(this.remote),ref:{...this.remote.ref,oid:tx.commit},objects:{...clone(this.remote.objects),...clone(tx.objects)}};const raw=readRemote(candidate);if(raw.tree!==tx.tree)throw new Error('Transaction result tree mismatch');
  let receipt;
  // Atomic synchronous compare/update: no await/yield between these two operations.
  if(this.remote.ref.oid!==tx.parent)receipt={operationId:tx.operationId,digest:tx.digest,status:'rejected',expected:tx.parent,observed:this.remote.ref.oid,commit:tx.commit};
  else{this.remote=candidate;receipt={operationId:tx.operationId,digest:tx.digest,status:'accepted',expected:tx.parent,observed:tx.commit,commit:tx.commit,tree:tx.tree};this.log.push({type:'REF_UPDATED',operationId:tx.operationId,commit:tx.commit});}
  this.receipts[tx.operationId]=receipt;return clone(receipt);
 }
 advance(change,label='intervening'){
  const raw=readRemote(this.remote);const files=Object.fromEntries(Object.entries(raw.files).map(([p,b])=>[p,Buffer.from(b)]));change(files);const result=buildTree(Object.fromEntries(Object.entries(files).map(([p,b])=>[p,{bytes:b,mode:raw.modes[p]||'100644'}])));
  const b=Buffer.from(`tree ${result.tree}\nparent ${raw.parent}\nauthor Synthetic Other <other@invalid> 1794873601 +0000\ncommitter Synthetic Other <other@invalid> 1794873601 +0000\n\nIndependent synthetic update ${label}\n`),id=oid('commit',b);
  this.remote={...this.remote,ref:{...this.remote.ref,oid:id},objects:{...this.remote.objects,...result.objects,[id]:{type:'commit',data:b.toString('base64')}}};this.log.push({type:'INDEPENDENT_UPDATE',commit:id});return id;
 }
 setDeployment(tx,status,overrides={}){verifyTx(tx);this.deployments[tx.commit]={commit:tx.commit,tree:tx.tree,status,page:status==='success'?{...tx.expectedPage,commit:tx.commit}:null,...clone(overrides)};}
 observeDeployment(commit){if(this.unreadable)throw new Error('Mock deployment unavailable');return clone(this.deployments[commit]||{commit,status:'unknown'});}
 exportState(){return clone({version:5,remote:this.remote,receipts:this.receipts,deployments:this.deployments,log:this.log,unreadable:this.unreadable,hideReceipt:this.hideReceipt});}
 static fromState(state){if(state.version!==5)throw new Error('Unsupported mock state');const r=new MockRemote(state.remote);r.receipts=clone(state.receipts);r.deployments=clone(state.deployments);r.log=clone(state.log);r.unreadable=!!state.unreadable;r.hideReceipt=!!state.hideReceipt;return r;}
}
module.exports={MockRemote,operationId,publicationCommit,sealTx,verifyTx,commitInfo,ancestor};
