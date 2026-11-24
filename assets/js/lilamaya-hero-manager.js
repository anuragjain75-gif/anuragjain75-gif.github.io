// A small view/controller for the existing Metadata hero section. Manuscript writes
// remain exclusively in the unified Save controller.
export function mountHeroControls(document,{group,figure,status,fields,metadata,documentPath,apiBase,onChange,onAsset,loadCurrent}) {
  let value=Object.hasOwn(fields,'hero')?fields.hero:undefined,asset=metadata.heroAsset,pending=false,busy=false,serial=0,blob=null,destroyed=false;
  const controls=document.createElement('div');controls.className='lilamaya-hero-controls';
  const make=(label,id)=>{const b=document.createElement('button');b.type='button';b.className='secondary-action';b.textContent=label;b.id=id;controls.append(b);return b;};
  const upload=make('Add Image','metadata-hero-upload'),remove=make('Remove Hero','metadata-hero-remove'),restore=make('Restore Legacy Hero','metadata-hero-restore');
  const input=document.createElement('input');input.type='file';input.accept='image/jpeg,image/png,image/webp';input.hidden=true;input.id='metadata-hero-file';controls.append(input);
  const note=document.createElement('p');note.className='lilamaya-metadata-note';note.textContent='Hero changes use Save. Original images are retained; social-card updates are reported separately.';group.append(controls,note);
  const guidance=document.createElement('p');guidance.className='lilamaya-metadata-note lilamaya-hero-guidance';guidance.textContent='Image changes take effect when you save this work.';group.insertBefore(guidance,note);
  note.classList.add('lilamaya-hero-preservation');note.textContent=note.textContent.replace('Hero changes use Save. ','');
  function release(){if(blob){URL.revokeObjectURL(blob);blob=null;}}
  function render(){
    const image=figure.querySelector('img:not([hidden])');
    const associated=value!==false&&(typeof value==='string'||!!(image?.complete&&image.naturalWidth));
    const label=associated?'Replace Image':'Add Image';if(upload.textContent!==label)upload.textContent=label;
    for(const [button,hidden,disabled] of [[upload,false,busy],[remove,!associated,busy||!associated],[restore,value===undefined,busy||value===undefined]]){
      if(button.hidden!==hidden)button.hidden=hidden;if(button.disabled!==disabled)button.disabled=disabled;
    }
  }
  const presentationObserver=new MutationObserver(render);presentationObserver.observe(figure,{childList:true,subtree:true,attributes:true,attributeFilter:['src','hidden']});
  figure.addEventListener('load',render,true);figure.addEventListener('error',render,true);
  function clear(){figure.querySelectorAll('img').forEach(e=>e.remove());release();}
  function changed(next,nextAsset){value=next;asset=nextAsset;pending=true;onAsset(asset);onChange('hero',value===undefined?{restoreLegacy:true}:value);render();}
  upload.addEventListener('click',()=>input.click());
  remove.addEventListener('click',()=>{if(busy)return;serial++;clear();changed(false,null);status.textContent='Pending: hero will be removed when saved. No image file will be deleted.';});
  restore.addEventListener('click',()=>{if(busy)return;serial++;clear();changed(undefined,null);status.textContent='Pending: legacy hero.* fallback will be restored when saved. Preview is available after Save.';});
  input.addEventListener('change',async()=>{
    const file=input.files?.[0];if(!file)return;const ticket=++serial;busy=true;render();status.textContent='Validating and uploading hero image…';
    let preview;
    try{
      const ext=file.name.split('.').pop().toLowerCase();if(!['jpg','jpeg','png','webp'].includes(ext)||file.size===0||file.size>8*1024*1024)throw Error('Choose a JPEG, PNG or WebP image smaller than 8 MB.');
      preview=URL.createObjectURL(file);const decoded=new Image();decoded.src=preview;await decoded.decode();if(!decoded.naturalWidth||!decoded.naturalHeight)throw Error('The image could not be decoded.');
      if(destroyed||ticket!==serial||!group.isConnected)return;
      if(!/^content\/(essays|paintings)\/[a-z0-9-]+\/index\.md$/.test(documentPath))throw Error('Hero uploads require an Essay or Painting page bundle.');
      const name='hero-'+crypto.randomUUID()+'.'+ext,reference='images/'+name,path=documentPath.slice(0,-8)+reference;
      const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
      const response=await fetch(apiBase+'/api/upload-image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,content:btoa(binary),local:true})});const result=await response.json();
      if(!response.ok||!result.ok||result.path!==path||!/^LOCAL:[a-f0-9]{64}$/.test(result.sha))throw Error(result.error||'Hero upload was not acknowledged safely.');
      if(destroyed||ticket!==serial||!group.isConnected)return;
      clear();blob=preview;preview=null;const image=document.createElement('img');image.className='lilamaya-metadata-hero-image';image.alt='Pending hero image';image.src=blob;figure.append(image);changed(reference,{path,sha:result.sha});status.textContent='Pending hero image — use Save to apply. The original image is unchanged.';
    }catch(error){if(!destroyed&&ticket===serial)status.textContent='Hero change failed: '+error.message+' The previous selection is retained.';}
    finally{if(preview)URL.revokeObjectURL(preview);if(!destroyed&&ticket===serial){busy=false;render();}input.value='';}
  });
  render();
  return {isPending:()=>pending||busy,saved(){pending=false;status.textContent=value===false?'No hero image.':value===undefined?'Legacy hero fallback saved.':'Hero image saved.';if(!blob&&value!==false)void loadCurrent({value});},destroy(){destroyed=true;serial++;presentationObserver.disconnect();figure.removeEventListener('load',render,true);figure.removeEventListener('error',render,true);release();}};
}
