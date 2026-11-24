'use strict';
let session=null,busy=false,confirmation=null;
const $=id=>document.getElementById(id);
function render(state){
 $('identity').textContent=(state.title||'')+' · '+(state.type||'')+' · '+(state.path||'');$('status').textContent=state.message||state.status;
 $('prepare').disabled=busy||!['ready','failed','cancelled','no-changes'].includes(state.status);
 $('confirm').disabled=busy||state.status!=='awaiting-confirmation'||!state.productionWritesEnabled||!confirmation;
 $('recover').hidden=state.status!=='unknown';$('recover').disabled=busy;$('cancel').disabled=busy||['submitting','deploying'].includes(state.status);
 if(state.liveURL){$('live').href=state.liveURL;$('live').hidden=false;}else $('live').hidden=true;
 if(state.review){const r=state.review;$('review').hidden=false;const publicURL = new URL(r.permalink, 'https://' + r.target.owner + '.github.io').href;
 $('target').textContent = r.operation + ' · ' + publicURL + ' · ' +
   r.target.owner + '/' + r.target.repo + ' · ' + r.target.branch +
   ' · expected parent ' + r.expectedParent;$('ledger').textContent=r.ledgerInitialization?'Includes explicitly reviewed initial identity-ledger creation.':r.enrollment?'Includes explicitly reviewed stable-identity enrollment.':'Existing stable publication identity retained.';$('files').replaceChildren(...r.files.map(f=>{const li=document.createElement('li');li.textContent=f.action+' '+f.path+' ('+(f.before||'absent')+' → '+(f.after||'removed')+')';return li;}));$('metadata').textContent=JSON.stringify({changes:r.metadata,transformations:r.transformations,retainedFormerAssets:r.retainedFormerAssets},null,2);$('before').textContent=r.sourceDiff.before;$('after').textContent=r.sourceDiff.after;}
}
async function action(name){if(busy||!session)return;busy=true;if(name==='prepare'){session.status='validating';session.message='Validating the saved version and remote foundation…';}render(session);try{const r=await fetch('/publishing/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csrf:session.csrf,confirmation,operation:session.operation})});const body=await r.json();if(!r.ok)throw Error(body.error||'Publication request failed');confirmation=body.confirmation||null;session={...session,...body};if(name==='cancel')window.close();}catch(error){session.message=error.message;session.status=session.operation?'unknown':'failed';confirmation=null;}finally{busy=false;render(session);}}
for(const id of ['prepare','confirm','recover','cancel'])$(id).addEventListener('click',()=>void action(id));
async function start(){try{const r=await fetch('/publishing/session',{cache:'no-store'});session=await r.json();if(!r.ok)throw Error(session.error);render(session);setInterval(async()=>{if(busy||!session||!['submitting','submitted','deploying','unknown'].includes(session.status))return;try{const r=await fetch('/publishing/status?ticket='+encodeURIComponent(session.ticket),{cache:'no-store'});if(r.ok){session={...session,...await r.json()};render(session);}}catch{$('status').textContent='Status is unavailable. No publication was retried.';}},1000);}catch(error){$('status').textContent=error.message;}}
void start();
