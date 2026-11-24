// The shared Metadata confirmation view performs no filesystem operations itself.
export const DELETE_KINDS=Object.freeze({essays:'Essay',fragments:'Fragment',paintings:'Painting',people:'Person',works:'Work',ideas:'Idea',traditions:'Tradition',places:'Place',journeys:'Journey'});
export function mountDeleteControl(document,panel,{type,path,reason,prepare,confirm}) {
  const kind=DELETE_KINDS[type];if(!kind)throw Error('Unsupported entry type');
  const element=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
  const section=element('section',undefined,'lilamaya-delete-section'),button=element('button','Delete '+kind,'lilamaya-delete-button'),status=element('p','','lilamaya-metadata-note');button.type='button';status.setAttribute('role','status');
  const dialog=element('dialog',undefined,'lilamaya-delete-dialog'),heading=element('h3','Delete '+kind+'?'),identity=element('p'),scope=element('ul'),warning=element('p'),references=element('ul'),label=element('label','Type DELETE to confirm this exact entry.'),input=element('input'),actions=element('div',undefined,'lilamaya-delete-actions'),cancel=element('button','Cancel','secondary-action'),submit=element('button','Move to Recovery','lilamaya-delete-button'),feedback=element('p','','lilamaya-metadata-note');
  heading.id='lilamaya-delete-heading';dialog.setAttribute('aria-labelledby',heading.id);input.id='lilamaya-delete-confirmation';input.autocomplete='off';input.spellcheck=false;label.htmlFor=input.id;cancel.type=submit.type='button';submit.disabled=true;feedback.setAttribute('role','alert');
  actions.append(cancel,submit);dialog.append(heading,identity,element('p','These reviewed files will leave the active content tree. A private recovery copy will be retained. Nothing is permanently erased.'),scope,warning,references,label,input,actions,feedback);section.append(button,status,dialog);panel.append(section);
  let busy=false,review=null,destroyed=false;
  function refresh() {
    const message=reason()||'',disabled=!!(busy||message);
    if(button.disabled!==disabled)button.disabled=disabled;
    if(button.title!==message)button.title=message;
    const cannotConfirm=!!(busy||!review||input.value!=='DELETE'||message);
    if(submit.disabled!==cannotConfirm)submit.disabled=cannotConfirm;
  }
  function close(){if(busy)return;dialog.close();review=null;input.value='';feedback.textContent='';button.focus();}
  cancel.addEventListener('click',close);
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();else{review=null;input.value='';}});
  input.addEventListener('input',refresh);
  button.addEventListener('click',async()=>{
    if(busy||reason())return;busy=true;refresh();status.textContent='Reviewing recovery scope…';
    try {
      const value=await prepare();if(destroyed)return;if(reason())throw Error(reason());
      if(value.path!==path||value.type!==type||!Array.isArray(value.files)||!value.files.includes(path))throw Error('The review does not match the open entry.');
      review=value;identity.textContent=`${value.title} · ${kind}\n${path}`;scope.replaceChildren(...value.files.map(name=>element('li',name)));
      warning.textContent=`${value.references?.items?.length||0} recorded incoming connection(s). ${value.references?.complete?'':'Reference inspection is incomplete. '}${value.references?.limitation||'Body links and shared assets are not exhaustively checked.'} No other entry will be changed. Standalone shared assets are retained.`;
      references.replaceChildren(...(value.references?.items||[]).map(item=>element('li',item.title+' — '+item.path)));
      input.value='';feedback.textContent='';dialog.showModal();input.focus();status.textContent='';
    }catch(error){if(!destroyed)status.textContent=error.message;}
    finally{busy=false;if(!destroyed)refresh();}
  });
  submit.addEventListener('click',async()=>{
    if(busy||!review||input.value!=='DELETE')return;
    const blocked=reason();if(blocked){feedback.textContent=blocked;refresh();return;}
    busy=true;cancel.disabled=true;refresh();feedback.textContent='Moving this entry to recovery…';
    try{await confirm(review,input.value);if(!destroyed){dialog.close();status.textContent='Recovery move completed.';}}
    catch(error){if(!destroyed)feedback.textContent=error.message;}
    finally{busy=false;if(!destroyed){cancel.disabled=false;refresh();}}
  });
  refresh();return {refresh,destroy(){destroyed=true;if(dialog.open)dialog.close();section.remove();}};
}
