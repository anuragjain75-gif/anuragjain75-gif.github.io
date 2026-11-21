import {mountHeroControls} from './lilamaya-hero-manager.js';
import {dateParts,composeDate} from './lilamaya-metadata-date.js';
// Metadata controls delegate document state and persistence to the existing controller.
export const METADATA_SCHEMAS = Object.freeze({
  essays: {themes: 'themes', hero: '.essay-hero img'},
  fragments: {themes: 'fragmentthemes', hero: null},
  paintings: {themes: 'paintingthemes', hero: '.painting-hero img'},
  ...Object.fromEntries(['people','works','ideas','traditions','places','journeys'].map(type=>[type,{titleOnly:true}]))
});
export function localMetadataURL(value, origin) {
  if (typeof value !== 'string' || !/^\/(?!\/)/.test(value) || /[\\\s?#]/.test(value)) return null;
  try { const url=new URL(value,origin); return url.origin===origin && ['http:','https:'].includes(url.protocol) ? url : null; } catch { return null; }
}
export function metadataRows(metadata) {
  if (!metadata || !Object.hasOwn(METADATA_SCHEMAS,metadata.type)) return [];
  const fields=metadata.fields || {}, rows=[];
  for (const [key,label] of [['title','Title'],['date','Date'],['draft','Draft status']]) {
    if (Object.hasOwn(fields,key)) rows.push([label,fields[key]]);
  }
  const themeKey=METADATA_SCHEMAS[metadata.type].themes;
  if(Object.hasOwn(fields,themeKey)) rows.push(['Assigned '+metadata.type.replace(/s$/,'')+' themes',fields[themeKey]]);
  if(metadata.type==='paintings') for(const key of ['artist','year']) if(Object.hasOwn(fields,key)) rows.push([key==='artist'?'Artist':'Year',fields[key]]);
  return rows;
}
// Display the authored calendar date without converting its timezone.
export function formatMetadataDate(value) {
  if(typeof value!=='string')return 'Not specified';
  const match=value.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[Tt ])/);
  if(!match)return 'Date unavailable';
  const [,year,month,day]=match.map(Number),date=new Date(0);
  date.setUTCHours(0,0,0,0);date.setUTCFullYear(year,month-1,day);
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return 'Date unavailable';
  return new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(date);
}
export function metadataDraftLabel(value) {
  return value===true?'Draft':value===false?'Published in local metadata':'Not specified';
}
export function metadataThemeLabel(value,type) {
  if(type==='essays')return value;
  const [first,...rest]=Array.from(value);return first?first.toUpperCase()+rest.join(''):value;
}
export function createMetadataPanel(document, metadata, permalink, origin, {onChange,loadThemes,mountThemes,heroContext} = {}) {
  if(!metadata || !Object.hasOwn(METADATA_SCHEMAS,metadata.type))return null;
  const fields=metadata.fields||{},schema=METADATA_SCHEMAS[metadata.type];
  const kind={essays:'Essay',fragments:'Fragment',paintings:'Painting',people:'Person',works:'Work',ideas:'Idea',traditions:'Tradition',places:'Place',journeys:'Journey'}[metadata.type];
  const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
  const text=(value,fallback='Not specified')=>typeof value==='string'&&value.trim()?value:typeof value==='number'&&Number.isFinite(value)?String(value):fallback;
  const utility=element('div','lilamaya-metadata-utility'),controls=element('div','lilamaya-metadata-controls');
  const button=element('button','lilamaya-metadata-toggle','Metadata');button.type='button';button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls','lilamaya-metadata-panel');
  const mark=element('span','lilamaya-metadata-mark','+');mark.setAttribute('aria-hidden','true');button.append(mark);controls.append(button);
  const panel=element('section','lilamaya-metadata-panel');panel.id='lilamaya-metadata-panel';panel.hidden=true;panel.setAttribute('aria-labelledby','lilamaya-metadata-heading');
  const heading=element('h3','lilamaya-metadata-heading','About this '+kind);heading.id='lilamaya-metadata-heading';
  panel.append(heading,element('p','lilamaya-metadata-note',typeof onChange==='function'?'Changes use Save in the bottom toolbar.':'Read-only · saved document details'));
  // Stable field containers allow later controls without a second document model.
  const field=(list,key,label,value,extra='')=>{
    const row=element('div','lilamaya-metadata-field '+extra);row.dataset.metadataField=key;
    const term=element('dt','lilamaya-metadata-label',label),definition=element('dd','lilamaya-metadata-value');term.id='metadata-label-'+key;
    if(typeof value==='string')definition.textContent=value;else definition.append(value);
    row.append(term,definition);list.append(row);return row;
  };
  const editable=typeof onChange==='function';
  const error=element('p','lilamaya-metadata-validation');error.setAttribute('role','alert');error.hidden=true;
  const inputFor=(key,value,multiline=false)=>{
    if(!editable)return text(value,key==='description'?'No description':'Not specified');
    const control=element(multiline?'textarea':'input','lilamaya-metadata-input');
    if(!multiline)control.type='text';else control.rows=3;
    control.id='metadata-input-'+key;control.setAttribute('aria-labelledby','metadata-label-'+key);control.value=value===undefined||value===null?'':String(value);
    if(key==='year')control.inputMode='numeric';if(key==='description')control.placeholder='No description';
    control.addEventListener('input',()=>onChange(key,control.value));return control;
  };
  const identity=element('dl','lilamaya-metadata-fields');
  field(identity,'title','Title',inputFor('title',fields.title),'lilamaya-metadata-field--title');
  // Litverse exposes its established title, without invented dates/taxonomies/heroes.
  if(schema.titleOnly){
    panel.append(identity,error);
    button.addEventListener('click',()=>{panel.hidden=!panel.hidden;button.setAttribute('aria-expanded',String(!panel.hidden));mark.textContent=panel.hidden?'+':'−';});
    utility.append(controls,panel);return {button,panel,utility,destroy(){},heroSaved(){},hasPendingHero(){return false;},setValidationMessage(message){if(error.textContent!==message)error.textContent=message;error.hidden=!message;}};
  }
  const date=element('time','',formatMetadataDate(fields.date));if(typeof fields.date==='string')date.dateTime=fields.date;
  const dateGroup=element('div','lilamaya-metadata-date');dateGroup.append(date);
  if(editable){
    const parts=dateParts(fields.date),calendar=element('input','lilamaya-metadata-input');calendar.type='date';calendar.id='metadata-input-date';calendar.setAttribute('aria-labelledby','metadata-label-date');calendar.value=parts?.day||'';
    const details=element('details','lilamaya-metadata-time'),summary=element('summary','','Show time details');details.append(summary);
    const label=element('label','lilamaya-metadata-label','Time (24-hour)'),clock=element('input','lilamaya-metadata-input');clock.type='text';clock.placeholder='HH:mm';clock.maxLength=5;clock.pattern='([01][0-9]|2[0-3]):[0-5][0-9]';clock.autocomplete='off';clock.id='metadata-input-time';label.htmlFor=clock.id;clock.value=parts?.time||'';clock.disabled=!parts?.time;
    const help=element('p','lilamaya-metadata-note',parts?.time?'Seconds, precision and original timezone are preserved.':'Date-only document. Adding time is unavailable until a timezone convention is approved.');details.append(label,clock,help);calendar.disabled=!parts;
    if(!parts)dateGroup.append(element('p','lilamaya-metadata-note','Unsupported stored date representation; preserved unchanged.'));
    function changed(){try{const value=composeDate(fields.date,calendar.value,clock.value);date.textContent=formatMetadataDate(value);date.dateTime=value;onChange('date',value);}catch(e){onChange('date',calendar.value+'T'+clock.value);error.textContent=e.message;error.hidden=false;}}
    calendar.addEventListener('input',changed);clock.addEventListener('input',changed);dateGroup.append(calendar,details);
  }
  field(identity,'date','Date',dateGroup);field(identity,'draft','Status',metadataDraftLabel(fields.draft));panel.append(identity);
  if(metadata.type==='paintings'){
    const details=element('dl','lilamaya-metadata-fields lilamaya-metadata-group');
    field(details,'artist','Artist',inputFor('artist',fields.artist));field(details,'year','Year',inputFor('year',fields.year));panel.append(details);
  }
  const themes=element('section','lilamaya-metadata-group');themes.dataset.metadataField=schema.themes;themes.dataset.taxonomy=schema.themes;themes.append(element('h4','lilamaya-metadata-label',kind+' themes'));
  const assigned=Array.isArray(fields[schema.themes])?fields[schema.themes].filter(value=>typeof value==='string'):[];
  if(assigned.length){
    const chips=element('ul','lilamaya-metadata-themes');chips.setAttribute('aria-label','Assigned '+kind.toLowerCase()+' themes');
    for(const value of assigned){const chip=element('li','lilamaya-metadata-theme',metadataThemeLabel(value,metadata.type));chip.dataset.themeValue=value;chips.append(chip);}themes.append(chips);
  }else themes.append(element('p','lilamaya-metadata-note','No themes assigned'));
  panel.append(themes);
  let themeManager;
  if(editable&&mountThemes){
    themes.querySelector('.lilamaya-metadata-themes')?.remove();themes.querySelector('p')?.remove();
    const select=element('select','theme-select-hidden');select.multiple=true;select.id='metadata-assigned-themes';select.setAttribute('aria-label','Assigned '+kind+' themes');
    const add=element('button','secondary-action add-theme-button','+ Add new theme');add.type='button';themes.append(select,add);
    void mountThemes({kind:metadata.type,select,addThemeButton:add,selected:assigned,autoAssignNew:false,onChange:values=>onChange(schema.themes,values)}).then(manager=>{if(panel.isConnected)themeManager=manager;else manager.destroy();}).catch(e=>{error.textContent=e.message;error.hidden=false;});
  }
  panel.append(error);
  let heroManager;
  const heroStatus=element('p','lilamaya-metadata-note');heroStatus.setAttribute('role','status');const hero=element('figure','lilamaya-metadata-hero');
  if(schema.hero){const group=element('section','lilamaya-metadata-group');group.dataset.metadataField='hero';group.append(element('h4','lilamaya-metadata-label lilamaya-hero-heading','Hero Image'));heroStatus.textContent='Open Metadata to view the current hero image.';hero.append(heroStatus);group.append(hero);panel.append(group);if(editable&&heroContext)heroManager=mountHeroControls(document,{group,figure:hero,status:heroStatus,fields,metadata,...heroContext,onChange,loadCurrent:loadHero});}
  let requested=false;
  let loadedHeroURL=null,heroRequest=0;
  async function loadHero(override) {
    if(heroManager?.isPending())return;
    const ticket=++heroRequest,selected=override?override.value:fields.hero;
    const page=localMetadataURL(permalink,origin);
    if(!page){heroStatus.textContent='Hero preview unavailable: no local preview URL.';return;}
    hero.querySelectorAll('img').forEach(e=>e.remove());
    if(loadedHeroURL){URL.revokeObjectURL(loadedHeroURL);loadedHeroURL=null;}
    if(selected===false){heroStatus.textContent='No hero image.';return;}
    heroStatus.textContent='Loading current hero image…';
    try {
      let source;
      if(selected!==undefined){
        if(typeof selected!=='string'||!/^images\/[a-z0-9][a-z0-9_-]{0,79}\.(jpg|jpeg|png|webp)$/.test(selected))throw Error('Invalid explicit hero reference');
        if(metadata.heroError)throw Error(metadata.heroError);
        source=selected;
      }else{
        const response=await fetch(page.href,{credentials:'omit',redirect:'error',cache:'no-store'});
        if(!response.ok || new URL(response.url).origin!==origin)throw Error('Hugo page unavailable');
        source=new DOMParser().parseFromString(await response.text(),'text/html').querySelector(schema.hero)?.getAttribute('src');
      }
      if(!panel.isConnected||heroManager?.isPending()||ticket!==heroRequest)return;
      if(!source){heroStatus.textContent='No hero image rendered by the current Hugo page.';return;}
      const url=new URL(source,page);if(url.origin!==origin||!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Unsafe image URL');
      const image=element('img','lilamaya-metadata-hero-image');image.alt='Current '+kind.toLowerCase()+' hero';
      // A unique explicit resource may precede Hugo's rebuild. Poll resource
      // readiness, not the old page HTML or a cached failed image request.
      if(selected!==undefined){
        const deadline=Date.now()+10000;
        while(true){
          const response=await fetch(url.href,{credentials:'omit',redirect:'error',cache:'no-store'});
          if(!panel.isConnected||heroManager?.isPending()||ticket!==heroRequest)return;
          if(response.ok&&new URL(response.url).origin===origin&&response.headers.get('content-type')?.startsWith('image/')){
            const blob=await response.blob();if(blob.size>8*1024*1024)throw Error('Hero preview is too large');
            const objectURL=URL.createObjectURL(blob);image.src=objectURL;
            try{await image.decode();}catch(error){URL.revokeObjectURL(objectURL);throw error;}
            if(!panel.isConnected||heroManager?.isPending()||ticket!==heroRequest){URL.revokeObjectURL(objectURL);return;}
            loadedHeroURL=objectURL;break;
          }
          if(response.status!==404||Date.now()>=deadline)throw Error('Explicit hero resource is unavailable');
          await new Promise(resolve=>setTimeout(resolve,150));
        }
      }else image.src=url.href;
      image.addEventListener('load',()=>{if(!heroManager?.isPending())heroStatus.textContent='';});
      image.addEventListener('error',()=>{if(!heroManager?.isPending()){image.hidden=true;heroStatus.textContent='Hero image could not be loaded. The existing file has not been changed.';}});
      hero.append(image);if(image.complete&&image.naturalWidth)heroStatus.textContent='';
    }catch(error){if(heroManager?.isPending()||!panel.isConnected||ticket!==heroRequest)return;heroStatus.textContent='Hero preview unavailable: '+error.message+'. No files have been changed.';}
  }
  // Mouse disclosure must not steal a writer's caret; Tab/Space still focus normally.
  button.addEventListener('mousedown',event=>{
    const active=document.activeElement;
    if(event.button===0&&active?.closest('#codemirror-editor')&&!active.closest('#lilamaya-metadata-panel')&&(active.isContentEditable||active.matches('textarea,input')))event.preventDefault();
  });
  // Outside the sticky title: expanded content scrolls normally.
  button.addEventListener('click',()=>{panel.hidden=!panel.hidden;button.setAttribute('aria-expanded',String(!panel.hidden));mark.textContent=panel.hidden?'+':'−';if(!panel.hidden&&schema.hero&&!requested){requested=true;void loadHero();}});
  utility.append(controls,panel);return {button,panel,utility,heroSaved(){heroManager?.saved();},hasPendingHero(){return !!heroManager?.isPending();},destroy(){themeManager?.destroy();heroManager?.destroy();heroRequest++;if(loadedHeroURL)URL.revokeObjectURL(loadedHeroURL);},setValidationMessage(message){if(error.textContent!==message)error.textContent=message;error.hidden=!message;}};
}
