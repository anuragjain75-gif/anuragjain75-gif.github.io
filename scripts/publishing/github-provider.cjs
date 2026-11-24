'use strict';
const crypto=require('crypto'),cp=require('child_process');
const {oid}=require('./engine/mock-git.cjs');
const {verifyTx}=require('./engine/mock-remote.cjs');
const {claimGrant}=require('./attempt-permit.cjs');
const {canonical}=require('./engine/editor-publish.cjs').internals;
const PRODUCTION_WRITES_ENABLED=false; // Permit-free real-provider writes are disabled.
const writesDisabled=()=>Object.assign(Error('Production publication writes are disabled without a journaled transaction permit.'),{code:'WRITES_DISABLED'});
const TRANSIENT_NETWORK_CODES=new Set(['ENOTFOUND','EAI_AGAIN','ECONNRESET','ETIMEDOUT']);
const MAX_GET_RETRIES=2;
const brand=new WeakSet();
function credentials(){
 if(process.env.GITHUB_TOKEN)return process.env.GITHUB_TOKEN;
 let bytes;try{bytes=cp.execFileSync('git',['-c','credential.interactive=never','credential','fill'],{input:'protocol=https\nhost=github.com\n\n',env:{PATH:process.env.PATH,HOME:process.env.HOME,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never',...(process.env.DBUS_SESSION_BUS_ADDRESS?{DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS}:{}),...(process.env.XDG_RUNTIME_DIR?{XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR}:{})},timeout:15000,maxBuffer:16384,stdio:['pipe','pipe','ignore']});const token=bytes.toString().match(/^password=(.+)$/m)?.[1];if(!token)throw Error();return token;}catch{throw Error('A usable GitHub HTTPS credential was not available; no publication was submitted.');}finally{bytes?.fill(0);}
}
async function network({method,url,headers,body}){const r=await fetch(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20000),cache:'no-store'});const bytes=Buffer.from(await r.arrayBuffer());return {status:r.status,bytes,body:r.headers.get('content-type')?.includes('json')?JSON.parse(bytes.toString()):null};}
function treeEntries(bytes){const result=[];let at=0;while(at<bytes.length){const space=bytes.indexOf(32,at),zero=bytes.indexOf(0,space+1);if(space<0||zero<0||zero+21>bytes.length)throw Error('Invalid Git tree');const mode=bytes.toString('ascii',at,space),name=bytes.toString('utf8',space+1,zero),sha=bytes.subarray(zero+1,zero+21).toString('hex');result.push({path:name,mode:mode==='40000'?'040000':mode,type:mode==='40000'?'tree':'blob',sha});at=zero+21;}return result;}
class GitHubProvider{
 #transport;#credential;#expectedIdentity;#controlled;#verifiedIdentity=null;#repositoryId=null;#token=null;
 constructor({owner,repo,branch='main',transport=network,credential=credentials,expectedIdentity=null,controlled=false,siteOrigin='https://'+owner+'.github.io'}={}){
  if(!/^[A-Za-z0-9_-]+$/.test(owner||'')||!/^[-.A-Za-z0-9_]+$/.test(repo||'')||branch!=='main'||new URL(siteOrigin).protocol!=='https:')throw Error('Invalid configured publication target');
  this.owner=owner;this.repo=repo;this.branch=branch;this.siteOrigin=new URL(siteOrigin).origin;this.#transport=transport;this.#credential=credential;this.#controlled=controlled===true;this.#expectedIdentity=expectedIdentity&&Object.freeze({...expectedIdentity});brand.add(this);
 }
 get writesEnabled(){return this.#transport.offlineMock===true;}
 get controlledAvailable(){return this.#controlled;}

 async request(method,endpoint,body){
  if(method!=='GET'&&!this.writesEnabled)throw writesDisabled();
  return this.#request(method,endpoint,body);
 }
 async #request(method,endpoint,body){
  if(!endpoint.startsWith('/')||endpoint.includes('..'))throw Error('Unsafe provider endpoint');
  const token=this.#token||await this.#credential();this.#token=token;let r,retries=0;
  for(;;){try{r=await this.#transport({method,url:'https://api.github.com'+endpoint,headers:{Accept:'application/vnd.github+json','Content-Type':'application/json',Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28'},body});break;}catch(error){
    const code=String(typeof error?.code==='string'?error.code:'UNKNOWN').replace(/[^A-Za-z0-9_.-]/g,'_').slice(0,80),name=String(typeof error?.name==='string'?error.name:'Error').replace(/[^A-Za-z0-9_.-]/g,'_').slice(0,80);
    if(method==='GET'&&TRANSIENT_NETWORK_CODES.has(code)&&retries<MAX_GET_RETRIES){retries++;continue;}
    const diagnostic=Error('GitHub transport failed ('+method+' '+endpoint+'; name='+name+'; code='+code+'; retries='+retries+').');diagnostic.cause=error;throw diagnostic;
  }}
  if(r.status<200||r.status>=300)throw Object.assign(Error('GitHub request failed (HTTP '+r.status+').'),{status:r.status});return r.body;
 }
 get base(){return '/repos/'+this.owner+'/'+this.repo;}
 async info(){const data=await this.request('GET',this.base);this.#repositoryId=data.node_id;return data;}
 async verifyIdentity(preparedIdentity){
  this.#verifiedIdentity=null;
  const expected=this.#expectedIdentity;
  if(!expected||!Number.isSafeInteger(expected.userId)||!expected.login||!expected.repositoryId||this.#credential===credentials)throw Error('Controlled publication requires a dedicated credential and pinned account and repository');
  if(preparedIdentity&&canonical(preparedIdentity)!==canonical(expected))throw Error('Publication account or repository pin changed after preparation');
  const user=await this.request('GET','/user'),repo=await this.info();
  if(user.id!==expected.userId||user.login!==expected.login||repo.node_id!==expected.repositoryId||
     repo.full_name!==this.owner+'/'+this.repo||repo.default_branch!==this.branch||repo.permissions?.push!==true)throw Error('Publication account or repository identity did not match');
  this.#verifiedIdentity=expected;
  return expected;
 }
 async actor(){const u=await this.request('GET','/user');if(!Number.isSafeInteger(u.id)||!/^[-A-Za-z0-9]+$/.test(u.login||''))throw Error('Invalid GitHub author identity');return {name:u.name||u.login,email:u.id+'+'+u.login+'@users.noreply.github.com'};}
 async head(){const r=await this.request('GET',this.base+'/git/ref/heads/main');if(r.object?.type!=='commit'||!/^([a-f0-9]{40})$/.test(r.object.sha))throw Error('Unexpected branch reference');return r.object.sha;}
 async commit(sha){const r=await this.request('GET',this.base+'/git/commits/'+sha);if(r.sha!==sha||!/^([a-f0-9]{40})$/.test(r.tree?.sha||'')||!Array.isArray(r.parents))throw Error('Invalid commit evidence');return r;}
 async snapshot(expected=null){
  const head=await this.head();if(expected&&head!==expected)throw Error('Remote parent changed');const root=await this.commit(head),objects={};let total=0;
  const visit=async(sha,depth=0)=>{
   if(objects[sha])return;if(depth>32||Object.keys(objects).length>20000)throw Error('Remote inventory limit');
   const r=await this.request('GET',this.base+'/git/trees/'+sha);if(r.sha!==sha||r.truncated||!Array.isArray(r.tree))throw Error('Incomplete remote tree');
   const seen=new Set(),entries=[...r.tree].sort((a,b)=>Buffer.compare(Buffer.from(a.path+(a.type==='tree'?'/':'')),Buffer.from(b.path+(b.type==='tree'?'/':''))));
   for(const e of entries){if(e.path.includes('/')||seen.has(e.path)||!['040000','100644','100755'].includes(e.mode)||!['tree','blob'].includes(e.type))throw Error('Unsafe remote tree mode/name');seen.add(e.path);
    if(e.type==='tree')await visit(e.sha,depth+1);
    else if(!objects[e.sha]){const b=await this.request('GET',this.base+'/git/blobs/'+e.sha);if(b.encoding!=='base64')throw Error('Unsupported blob encoding');const bytes=Buffer.from(b.content.replace(/\s/g,''),'base64');total+=bytes.length;if(bytes.length>20*1024*1024||total>200*1024*1024||oid('blob',bytes)!==e.sha)throw Error('Invalid or oversized blob');objects[e.sha]={type:'blob',data:bytes.toString('base64')};}
   }
   const bytes=Buffer.concat(entries.map(e=>Buffer.concat([Buffer.from((e.mode==='040000'?'40000':e.mode)+' '+e.path+'\0'),Buffer.from(e.sha,'hex')])));if(oid('tree',bytes)!==sha)throw Error('Remote tree hash mismatch');objects[sha]={type:'tree',data:bytes.toString('base64')};
  };
  await visit(root.tree.sha);return {kind:'github-snapshot',ref:{name:'refs/heads/main',oid:head},commitRecord:root,objects};
 }
 async publish(tx,grant,journal){
  if(!this.writesEnabled&&!this.#controlled)throw writesDisabled();
  verifyTx(tx);
  if(!tx.target||tx.target.owner!==this.owner||tx.target.repo!==this.repo||tx.target.branch!==this.branch)throw Error('Reviewed publication target changed');
  let repositoryId;
  if(this.#controlled){
   if(!this.#verifiedIdentity||tx.expectedLive?.siteOrigin!==this.siteOrigin)throw Error('Publication identity or public destination was not verified');
   claimGrant(grant,tx,this.#verifiedIdentity,journal);
   repositoryId=this.#verifiedIdentity.repositoryId;
   this.#verifiedIdentity=null;
  }else{
   if(!this.#repositoryId)await this.info();
   repositoryId=this.#repositoryId;
  }
  const sent=new Set();
  const upload=async id=>{if(sent.has(id)||!tx.objects[id])return;const o=tx.objects[id],bytes=Buffer.from(o.data,'base64');if(o.type==='commit')return;
   let r;if(o.type==='blob')r=await this.#request('POST',this.base+'/git/blobs',{content:o.data,encoding:'base64'});
   else{const tree=treeEntries(bytes);for(const e of tree)await upload(e.sha);r=await this.#request('POST',this.base+'/git/trees',{tree});}
   if(r.sha!==id)throw Error('Uploaded Git object hash differs from approved transaction');sent.add(id);
  };
  await upload(tx.tree);
  const raw=Buffer.from(tx.objects[tx.commit].data,'base64').toString(),split=raw.indexOf('\n\n'),actor={name:tx.committer.name,email:tx.committer.email,date:new Date(tx.committer.time*1000).toISOString()};
  const created=await this.#request('POST',this.base+'/git/commits',{tree:tx.tree,parents:[tx.parent],message:raw.slice(split+2),author:actor,committer:actor});if(created.sha!==tx.commit)throw Error('Created commit differs from the approved commit');
  // Server-enforced expected-parent compare-and-swap. clientMutationId is NOT a receipt.
  const result=await this.#request('POST','/graphql',{query:'mutation Publish($input: UpdateRefsInput!) { updateRefs(input:$input) { clientMutationId } }',variables:{input:{repositoryId,clientMutationId:tx.operationId,refUpdates:[{name:'refs/heads/main',beforeOid:tx.parent,afterOid:tx.commit,force:false}]}}});
  if(result.errors||!result.data?.updateRefs)throw Object.assign(Error('Conditional branch update was rejected or not acknowledged.'),{code:'CONDITIONAL_REJECTED'});
  return {acknowledged:true};
 }
 async contains(head,wanted){const queue=[head],seen=new Set();while(queue.length){if(seen.size>=1000)throw Error('Ancestry evidence is incomplete');const at=queue.shift();if(seen.has(at))continue;seen.add(at);const c=await this.commit(at);if(at===wanted)return c;for(const p of c.parents){if(!/^[a-f0-9]{40}$/.test(p.sha))throw Error('Invalid ancestry');queue.push(p.sha);}}return null;}
 async deployment(tx){
  const r=await this.request('GET',this.base+'/actions/workflows/hugo.yml/runs?branch=main&event=push&head_sha='+tx.commit+'&per_page=100');const runs=r.workflow_runs?.filter(x=>x.head_sha===tx.commit&&x.head_branch==='main'&&x.event==='push')||[];
  if(!runs.length)return {state:'submitted',message:'GitHub accepted the commit; its deployment run has not appeared.'};const run=runs.sort((a,b)=>b.run_attempt-a.run_attempt||b.id-a.id)[0];
  if(run.status!=='completed')return {state:'deploying',runURL:run.html_url,message:'GitHub Pages is deploying the accepted commit.'};
  if(run.conclusion!=='success')return {state:['cancelled','timed_out'].includes(run.conclusion)?run.conclusion:'failed',runURL:run.html_url,message:'GitHub accepted the commit, but deployment '+run.conclusion+'.'};
  let page,latest;try{page=await this.request('GET',this.base+'/pages/deployments/'+tx.commit);latest=await this.request('GET',this.base+'/deployments?environment=github-pages&per_page=100');}catch{return {state:'unverified',message:'Workflow completed; Pages deployment identity could not be verified.'};}
  if(page.status!=='succeed')return {state:page.status==='failed'?'failed':'deploying',message:'Workflow completed; Pages deployment is '+page.status+'.'};
  if(!Array.isArray(latest)||!latest.length)return {state:'unverified',message:'Current deployment evidence is unavailable.'};
  if(latest[0].sha!==tx.commit)return {state:'superseded',message:'A different commit has a newer Pages deployment.'};
  try{
   const expected=tx.expectedLive,url=this.siteOrigin+expected.url,response=await this.#transport({method:'GET',url:url+'?lilamaya_publication='+tx.commit,headers:{Accept:'text/html','Cache-Control':'no-cache'}});
   const digest=b=>crypto.createHash('sha256').update(b).digest('hex');if(response.status!==200||digest(response.bytes)!==expected.htmlHash)return {state:'unverified',message:'Deployment completed, but the live page does not match the reviewed build.'};
   for(const [p,hash]of Object.entries(expected.assets)){const asset=await this.#transport({method:'GET',url:this.siteOrigin+p+'?lilamaya_publication='+tx.commit,headers:{'Cache-Control':'no-cache'}});if(asset.status!==200||digest(asset.bytes)!==hash)return {state:'unverified',message:'A required live asset is missing or differs from the reviewed build.'};}
   return {state:'live',liveURL:url,message:'The accepted commit, deployment, public page and required assets were verified.'};
  }catch{return {state:'unverified',message:'Deployment completed; the public page could not be verified.'};}
 }
}
module.exports={GitHubProvider,isProvider:p=>brand.has(p),credentials,treeEntries,PRODUCTION_WRITES_ENABLED};
