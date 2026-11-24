import {installPublisher} from './lilamaya-publish.js';
import {mountDeleteControl} from './lilamaya-delete-entry.js';
import {mountThemeManager} from './lilamaya-theme-manager.js';
import metadataPatch from './lilamaya-metadata-patch.cjs';
import {createMetadataPanel} from "./lilamaya-metadata-panel.js";
// Creation reuses the existing local form, editor and save lifecycle.
let newDocumentType = "essays";
let fragmentThemesLoaded = false;
let paintingThemesLoaded = false;
import {createLilamayaEditor} from "./lilamaya-rich-editor.js";
import {createSaveSafety, createSaveSafetyPanel} from "./lilamaya-save-safety.mjs";

const defaultDocumentPath = "content/essays/the-art-of-becoming-whole/index.md";
let documentPath = defaultDocumentPath;
let documentSha = null;
let documentIsLocal = false;
let richEditor = null;
let savedContent = null;
let savedConnections = "[]";
let newEssayMode = false;
let newEntryMode = false;
let availableDocuments = [];
let saveSafety = null;
let publicationUI=null;
function publishEligibility(){
 const saved=getPreviewState();
 const assetsPending=imageInsertionBusy||metadataView?.hasPendingHero();
 const eligible=privateDesk&&!!saved.url&&!assetsPending;
 const reason=eligible?'Publish this saved version.':assetsPending?'Finish and save pending image changes before publishing.':saved.reason;
 return {eligible,path:documentPath,sha:documentSha,reason};
}
let pendingSave = null;
let pendingEditor = null;
let lastSaveHttpStatus = null;
let acknowledgedDiskKnown = false;
let documentLoading = false;
let saveValidationError = null;
let metadataEdits = {};
let metadataType = null;
let metadataHeroAsset = null;
let metadataView = null;
let deleteView=null,deleteBusy=false,deleteUncertain=false,imageInsertionBusy=false;
function deletionBlocked(){
  const state=saveSafety?.state();
  if(deleteUncertain)return 'Recovery requires inspection. Export your draft before closing; do not retry or save.';
  if(deleteBusy||documentLoading||pendingSave||imageInsertionBusy||socialCardBusy||state?.busy||metadataView?.hasPendingHero())return 'Wait for the current operation and save pending image changes before deleting.';
  if(!richEditor||!documentIsLocal||!acknowledgedDiskKnown||state?.issue||!state?.canRetry||saveValidationError||hasUnsavedBufferChanges())return 'Save all changes and resolve Draft Safety warnings before deleting.';
  return '';
}
async function deletionRequest(route,body){
  const response=await fetch(apiBase+'/api/delete-entry/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok||!result.ok)throw Object.assign(Error(result.error||'Recovery move was not confirmed.'),{outcome:result.outcome||'uncertain'});
  return result;
}
async function prepareDeletion(){
  const blocked=deletionBlocked();if(blocked)throw Error(blocked);
  const identity=currentBufferIdentity(),path=documentPath,sha=documentSha,editor=richEditor;
  const {review}=await deletionRequest('prepare',{path,sha});
  if(editor!==richEditor||path!==documentPath||sha!==documentSha||identity!==currentBufferIdentity()||deletionBlocked())throw Error('The draft changed during review. Nothing was moved.');
  return review;
}
async function confirmDeletion(review,confirmation){
  const blocked=deletionBlocked();if(blocked)throw Error(blocked);
  if(review.path!==documentPath||review.revision!==documentSha)throw Error('The reviewed revision is no longer open.');
  const editor=richEditor,identity=currentBufferIdentity();deleteBusy=true;renderSaveStatus();
  let result;
  try{
    result=await deletionRequest('confirm',{token:review.token,path:documentPath,sha:documentSha,confirmation});
    if(result.deleted!==true||result.path!==documentPath||!result.recoveryId||editor!==richEditor||identity!==currentBufferIdentity())throw Error('The draft or recovery response changed. Export your draft and inspect recovery.');
  }catch(error){
    if(error.outcome!=='unchanged'){deleteUncertain=true;acknowledgedDiskKnown=false;}
    deleteBusy=false;renderSaveStatus();throw error;
  }
  // Never dispose a draft until the backend explicitly verifies the move.
  try{
    cleanupStickyTitle?.();cleanupStickyTitle=null;
    await richEditor.destroy();richEditor=null;window.__lilamayaRichEditor=null;
    deleteView?.destroy();deleteView=null;metadataView?.destroy();metadataView=null;
    localStorage.removeItem('lilamaya-editor-document-path');
    availableDocuments=availableDocuments.filter(item=>item.path!==documentPath);
    documentPath=null;documentSha=null;documentIsLocal=false;savedContent=null;savedConnections='[]';metadataEdits={};metadataType=null;metadataHeroAsset=null;
    socialCardEpoch++;socialCardResult=null;socialCardBusy=false;acknowledgedDiskKnown=false;deleteBusy=false;
    document.querySelector('#codemirror-editor').replaceChildren();showLibraryScreen();renderSaveStatus();
  }catch(error){deleteBusy=false;deleteUncertain=true;acknowledgedDiskKnown=false;renderSaveStatus();throw Error('Entry moved to recovery '+result.recoveryId+', but editor cleanup needs inspection.');}
  const notice=document.createElement('p');notice.className='lilamaya-metadata-note';notice.setAttribute('role','status');notice.textContent='Moved to local recovery: '+result.recoveryId;
  document.querySelector('#document-selector').prepend(notice);
  try{await loadDocumentList();document.querySelector('#document-selector').prepend(notice);}
  catch{notice.textContent+=' · Library refresh failed. Reopen the library before selecting another entry.';}
}
let socialCardResult=null,socialCardEpoch=0,socialCardBusy=false;
function renderSocialCard(){
 const group=document.querySelector('#lilamaya-metadata-panel [data-metadata-field="hero"]');if(!group)return;
 let box=group.querySelector('.lilamaya-social-card-status');
 if(!box){box=document.createElement('div');box.className='lilamaya-social-card-status';const message=document.createElement('p');message.className='lilamaya-metadata-note';message.setAttribute('role','status');const retry=document.createElement('button');retry.type='button';retry.className='secondary-action';retry.textContent='Retry Social Card';retry.addEventListener('click',retrySocialCard);box.append(message,retry);group.append(box);}
 const status=socialCardResult?.status;
 let message=socialCardBusy?'Updating social card…':status==='updated'?'Last saved version: social card updated.':status==='current'?'Social card is current for the saved version.':status==='failed'?'Last saved version: social-card update failed. You can retry without saving again.':status==='stale'?'Social card needs updating. Save relevant changes or retry the saved version.':'Social-card status unavailable.';
 if(status==='failed'&&typeof socialCardResult.message==='string')message+=' '+socialCardResult.message.slice(0,400);
 const paragraph=box.querySelector('p');if(paragraph.textContent!==message)paragraph.textContent=message;
 const retry=box.querySelector('button'),hidden=status==='updated'||status==='current',disabled=socialCardBusy||documentLoading||!acknowledgedDiskKnown||pendingSave!==null||hasUnsavedBufferChanges();if(retry.hidden!==hidden)retry.hidden=hidden;if(retry.disabled!==disabled)retry.disabled=disabled;const title=disabled?'Preserve and save pending manuscript changes before retrying.':'Update only the saved document’s social card.';if(retry.title!==title)retry.title=title;
}
async function retrySocialCard(){
 if(socialCardBusy||documentLoading||pendingSave||!acknowledgedDiskKnown||hasUnsavedBufferChanges())return;
 const epoch=++socialCardEpoch,path=documentPath,sha=documentSha;socialCardBusy=true;renderSocialCard();
 try{const response=await fetch(apiBase+'/api/social-card/retry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,sha})});const result=await response.json();if(epoch!==socialCardEpoch||path!==documentPath||sha!==documentSha)return;socialCardResult=response.ok?result.socialCard:{status:'failed'};}
 catch{if(epoch===socialCardEpoch)socialCardResult={status:'failed'};}
 finally{if(epoch===socialCardEpoch){socialCardBusy=false;renderSocialCard();}}
}
function composeCurrentMarkdown() {
  const source=richEditor.getMarkdown();
  return metadataType && Object.keys(metadataEdits).length ? metadataPatch.patchMetadata(source,metadataType,metadataEdits) : source;
}
function updateMetadata(key,value) {
  metadataEdits={...metadataEdits,[key]:Array.isArray(value)?[...value]:value};
  if(key==='title'){const heading=document.querySelector('.lilamaya-document-title');if(heading)heading.textContent=value;}
  try {composeCurrentMarkdown();metadataView?.setValidationMessage('');}
  catch(error){metadataView?.setValidationMessage(error.message);}
  renderSaveStatus();
}
async function loadMetadataThemes(type) {
  const stem={essays:'essay',fragments:'fragment',paintings:'painting'}[type];
  if(!stem)throw new Error('Unsupported theme collection');
  const response=await fetch(apiBase+'/api/'+stem+'-themes');
  if(!response.ok)throw new Error('Theme collection unavailable');
  return response.json();
}


function differsFromSubmitted(draft) {
  if (!richEditor || draft.path !== documentPath) return true;
  try {
    return composeCurrentMarkdown() !== draft.markdown ||
      JSON.stringify(collectDocumentConnections()) !== JSON.stringify(draft.connections);
  } catch { return true; }
}

function hasUnsavedBufferChanges() {
  if (!richEditor || savedContent === null) return false;
  if (!acknowledgedDiskKnown) return true;
  try {
    return composeCurrentMarkdown() !== savedContent ||
      JSON.stringify(collectDocumentConnections()) !== savedConnections;
  } catch { return true; }
}

function getPreviewState(state = saveSafety?.state()) {
  const blocked = reason => ({url: null, reason});
  if (documentLoading || !richEditor || newEssayMode || newEntryMode ||
      document.querySelector(".editor-actions").hidden || !documentIsLocal ||
      typeof documentPath !== "string" || !/^content\/[^\\\u0000-\u001f]+\.md$/i.test(documentPath) ||
      documentPath.split("/").some(part => !part || part === "." || part === "..") ||
      !Object.hasOwn(metadataPatch.FIELDS, documentPath.split("/")[1])) {
    return blocked("Open a saved local entry to preview.");
  }
  if (deleteBusy || deleteUncertain || !state || state.busy || pendingSave || state.issue || saveValidationError ||
      !acknowledgedDiskKnown || typeof savedContent !== "string" ||
      !/^LOCAL:[a-f0-9]{64}$/.test(documentSha) || hasUnsavedBufferChanges() ||
      document.querySelector("#save-status").textContent !== "Saved") {
    return blocked("Save changes and resolve any save warning before previewing.");
  }
  const permalink = availableDocuments.find(item => item.path === documentPath)?.permalink;
  try {
    const origin = new URL(window.location.origin);
    if (origin.port === "1314" && ["localhost", "127.0.0.1"].includes(origin.hostname)) origin.port = "1313";
    if (origin.protocol !== "http:" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
        typeof permalink !== "string" || !/^\/(?!\/)/.test(permalink) ||
        /[\s\\?#]/.test(permalink)) throw new Error("Unsafe preview URL");
    const decoded = decodeURIComponent(permalink);
    if (decoded.startsWith("//") || /[\\\u0000-\u001f\u007f?#]/.test(decoded) ||
        decoded.split("/").some(part => part === "." || part === "..")) {
      throw new Error("Unsafe preview path");
    }
    const url = new URL(permalink, origin);
    if (url.origin !== origin.origin || url.username || url.password || url.search || url.hash) {
      throw new Error("Unsafe preview origin");
    }
    return {url: url.href, reason: "Preview the saved document on local Hugo. Recent saves may take a moment to render."};
  } catch {
    return blocked("No safe local Hugo preview URL is available for this document.");
  }
}

function renderPreviewButton(state = saveSafety?.state()) {
  const button = document.querySelector("#preview-editor");
  const preview = getPreviewState(state);
  button.disabled = !preview.url;
  button.title = preview.reason;
  button.setAttribute("aria-label", "Preview — " + preview.reason);
}

function previewDocument() {
  const button = document.querySelector("#preview-editor");
  const preview = getPreviewState();
  if (!preview.url) { renderPreviewButton(); window.alert(preview.reason); return; }
  if (button.disabled) return;
  window.open(preview.url, "_blank", "noopener,noreferrer");
}

function renderSaveStatus(state = saveSafety?.state()) {
  const status = document.querySelector("#save-status");
  if (!status) return;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  document.querySelector("#save-editor").disabled =
    deleteBusy || deleteUncertain || documentLoading || !richEditor || !state?.canRetry;
  // A stale/uncertain outcome invalidates our old view of disk, even after the
  // user explicitly acknowledges recovery review. Only load/save reestablishes it.
  if (state?.issue && (state.issue.kind === "stale" || state.issue.publication !== "none")) {
    acknowledgedDiskKnown = false;
  }
  let text = "";
  if(deleteUncertain) text = "Recovery outcome uncertain — export your draft and inspect recovery before further writes.";
  else if(deleteBusy) text = "Moving to recovery…";
  else if (documentLoading) text = "Opening…";
  else if (state?.busy) text = pendingSave && differsFromSubmitted(pendingSave)
    ? "Saving… — newer changes unsaved" : "Saving…";
  else if (state?.issue) text = state.issue.kind === "stale" || lastSaveHttpStatus === 409
    ? "Conflict — preserve your draft and review the warning."
    : "Save failed — preserve your draft and review the warning.";
  else if (saveValidationError) text = "Save failed — " + saveValidationError;
  else if (richEditor && savedContent !== null) text = hasUnsavedBufferChanges() ? "Unsaved" : "Saved";
  if (status.textContent !== text) status.textContent = text;
  deleteView?.refresh();
  renderPreviewButton(state);
  if(!publicationUI&&document.querySelector('#publish-status'))publicationUI=installPublisher({button:document.querySelector('#publish-editor'),status:document.querySelector('#publish-status'),getState:publishEligibility});
  publicationUI?.render();
  renderSocialCard();
}

function initializeSaveStatusNotifications() {
  const editor = document.querySelector("#codemirror-editor");
  const connections = document.querySelector("#document-connection-list");
  let queued = false;
  const changed = () => {
    saveValidationError = null;
    // Invalidate a visible Saved label immediately; reconcile after Milkdown's
    // DOM observer has processed the edit. No debounce timer, autosave or retry.
    const status = document.querySelector("#save-status");
    if (richEditor && !documentLoading && !saveSafety?.state().issue && status.textContent === "Saved") {
      status.textContent = "Unsaved";
    }
    document.querySelector("#preview-editor").disabled = true;
    document.querySelector("#preview-editor").title = "Save changes before previewing.";
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; renderSaveStatus(); });
  };
  for (const root of [editor, connections]) {
    root.addEventListener("input", changed);
    root.addEventListener("change", changed);
    new MutationObserver(changed).observe(root, {
      subtree: true, childList: true, characterData: true, attributes: true
    });
  }
}

function currentBufferIdentity() {
  if (!richEditor) return null;
  const {segments, ...snapshot} = richEditor.captureDraftSnapshot();
  // Derived serialized source may refresh without an edit; compare live nodes
  // and protected fields instead when guarding a pending document load.
  return JSON.stringify({...snapshot,
    segments: segments.map(({source, originalSource, ...live}) => live),
    connections: collectDocumentConnections(),metadata:metadataEdits,heroAsset:metadataHeroAsset});
}


function captureUnsavedDraft() {
  if (!richEditor) throw new Error("No manuscript is loaded.");
  const snapshot = richEditor.captureDraftSnapshot();
  let baseFrontmatter=snapshot.frontmatter;
  let markdown=null, serializationError=null;
  let raw=null;
  try {raw=richEditor.getMarkdown();if(metadataType&&Object.keys(metadataEdits).length)baseFrontmatter=metadataPatch.frontmatter(raw).source;markdown=metadataType&&Object.keys(metadataEdits).length?metadataPatch.patchMetadata(raw,metadataType,metadataEdits):raw;} catch(error) { serializationError=error.message; }
  return {path:documentPath, revision:documentSha, snapshot, markdown, serializationError,
    ...(metadataType?{metadata:{changes:JSON.parse(JSON.stringify(metadataEdits)),baseFrontmatter,heroAsset:metadataHeroAsset,expectedPermalink:availableDocuments.find(item=>item.path===documentPath)?.permalink}}:{}),
    connections:collectDocumentConnections()};
}

function initializeSaveSafety() {
  if(saveSafety)return;
  let panel;
  const download=()=>saveSafety.exportDraft(async payload=>{
    const url=URL.createObjectURL(new Blob([payload.text],{type:"application/json;charset=utf-8"}));
    const a=document.createElement("a");a.href=url;a.download="lilamaya-unsaved-draft-"+(typeof crypto.randomUUID==="function"?crypto.randomUUID():Date.now()+"-"+Math.random().toString(16).slice(2))+".json";
    document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  });
  const copy=()=>saveSafety.exportDraft(async payload=>{
    if(!navigator.clipboard?.writeText)throw new Error("Clipboard is unavailable; use download.");
    await navigator.clipboard.writeText(payload.text);
  });
  panel=createSaveSafetyPanel(document,document.querySelector(".editor-actions"),{
    download,copy,resolve:flags=>saveSafety.acknowledgeResolution(flags)
  });
  saveSafety=createSaveSafety({readDraft:captureUnsavedDraft,isDirty:hasUnsavedChanges,
    confirmResolution:()=>window.confirm("Confirm that you preserved the latest exported draft and reviewed all disk/recovery versions. Nothing will be reloaded or restored. Continue?"),
    onSaved:(result,draft)=>{
      if (draft.path !== documentPath || pendingEditor !== richEditor) {
        throw new Error("The save acknowledgment belongs to a different editor.");
      }
      documentSha=result.sha;
      socialCardEpoch++;socialCardBusy=false;socialCardResult=result.socialCard||null;
      savedContent=draft.markdown;
      if(JSON.stringify(draft.metadata?.changes?.hero)===JSON.stringify(metadataEdits.hero)&&JSON.stringify(draft.metadata?.heroAsset)===JSON.stringify(metadataHeroAsset))metadataView?.heroSaved();
      savedConnections=JSON.stringify(draft.connections);
      acknowledgedDiskKnown=true;
    },
    render:state=>{
      panel.render(state);
      renderSaveStatus(state);
    }});
  window.addEventListener("beforeunload",event=>saveSafety.beforeUnload(event));
  initializeSaveStatusNotifications();
}


function showLibraryScreen() {
  newEssayMode = false;
  newEntryMode = false;

  document.querySelector("#new-essay-form").hidden = true;
  document.querySelector("#new-entry-form").hidden = true;
  const documentSelector = document.querySelector("#document-selector");
  documentSelector.hidden = false;
  renderDocumentSelector(availableDocuments);

  documentSelector.querySelectorAll(
    ".document-selector-select"
  ).forEach(select => {
    select.value = "";
  });

  document.querySelector("#document-connections").hidden = true;
  document.querySelector(".editor-actions").hidden = true;
  document.querySelector("#codemirror-editor").hidden = true;
}

function showEditorScreen() {
  newEssayMode = false;
  newEntryMode = false;

  document.querySelector("#new-essay-form").hidden = true;
  document.querySelector("#new-entry-form").hidden = true;
  document.querySelector("#document-selector").hidden = true;
  document.querySelector("#document-connections").hidden = false;
  document.querySelector(".editor-actions").hidden = false;
  document.querySelector("#codemirror-editor").hidden = false;
  renderPreviewButton();
}

const privateDesk = location.protocol === "http:" &&
  ["localhost", "127.0.0.1"].includes(location.hostname) && location.port === "1314";
const apiBase = privateDesk ? location.origin : "http://localhost:1314";
if (location.origin === "http://localhost:1313") {
  location.replace(apiBase + "/editor-test/");
}

async function fetchDocument(path) {
  const response = await fetch(
    apiBase + "/api/document?path=" + encodeURIComponent(path)
  );

  if (!response.ok) {
    throw new Error(`Load failed: ${response.status}`);
  }

  return response.json();
}


async function handleImageInsertion(insertImageAtCursor) {
  if(deleteBusy||deleteUncertain)throw Error('Resolve the recovery operation before inserting an image.');
  imageInsertionBusy=true;renderSaveStatus();
  try{return await performImageInsertion(insertImageAtCursor);}
  finally{imageInsertionBusy=false;renderSaveStatus();}
}
async function performImageInsertion(insertImageAtCursor) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/jpeg,image/png,image/webp";
  input.hidden = true;
  document.body.appendChild(input);

  const file = await new Promise(resolve => {
    input.addEventListener("change", () => {
      resolve(input.files?.[0] || null);
      input.remove();
    }, {once: true});

    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    }, {once: true});

    input.click();
  });

  if (!file) return;

  try {
    const extension = file.name.split(".").pop().toLowerCase();

    if (!["jpg", "jpeg", "png", "webp"].includes(extension)) {
      throw new Error("Please choose a JPEG, PNG, or WebP image.");
    }

    if (file.size > 8 * 1024 * 1024) {
      throw new Error("The image must be smaller than 8 MB.");
    }

    const originalStem = file.name.replace(/\.[^.]+$/, "");
    const altText = originalStem
      .replace(/[^a-zA-Z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Image";

    const filenameStem = originalStem
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "image";

    const filename = `${filenameStem}-${Date.now()}.${extension}`;
    const bundle = documentPath.match(/^content\/(essays|fragments|paintings)\/([a-z0-9-]+)\/index\.md$/i);
    const standalone = documentPath.match(/^content\/fragments\/([a-z0-9-]+)\.md$/i);

    if (!bundle && !standalone) throw new Error("Images require an essay, fragment or painting document.");
    const imagePath = bundle
      ? `content/${bundle[1]}/${bundle[2]}/images/${filename}`
      : `static/images/fragments/${standalone[1]}/${filename}`;
    const imageReference = bundle ? `images/${filename}` : `/images/fragments/${standalone[1]}/${filename}`;

    const base64Content = await new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => {
        const result = String(reader.result || "");
        const comma = result.indexOf(",");

        if (comma < 0) {
          reject(new Error("Could not read the selected image."));
          return;
        }

        resolve(result.slice(comma + 1));
      };

      reader.onerror = () => reject(
        new Error("Could not read the selected image.")
      );

      reader.readAsDataURL(file);
    });

    const response = await fetch(`${apiBase}/api/upload-image`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        path: imagePath,
        content: base64Content,
        local: documentIsLocal
      })
    });

    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Image upload failed.");
    }

    const markdown =
      `![${altText.replace(/[\[\]\\]/g, "")}](${imageReference})`;

    const previewUrl = URL.createObjectURL(file);

    try {
      await insertImageAtCursor(markdown, previewUrl);
    } catch (error) {
      URL.revokeObjectURL(previewUrl);
      throw error;
    }

    console.log("Inline image uploaded:", result.path);
  } catch (error) {
    console.error("Inline image insertion failed:", error);
    alert(error.message || "Could not insert the image.");
  }
}

let cleanupStickyTitle = null;

async function loadDocument(path) {
  if(deleteBusy||deleteUncertain)throw Error("Resolve the recovery operation before opening another entry.");
  cleanupStickyTitle?.();
  cleanupStickyTitle = null;
  if(saveSafety && !saveSafety.canNavigate()) throw new Error("Preserve your current draft and resolve its warning before opening another document.");
  if (documentLoading) throw new Error("Another manuscript is still opening.");
  const previousEditor = richEditor;
  const previousBuffer = currentBufferIdentity();
  documentLoading = true;
  renderSaveStatus();
  try {
  const data = await fetchDocument(path);
  if (previousEditor !== richEditor || previousBuffer !== currentBufferIdentity() ||
      (saveSafety && !saveSafety.canNavigate())) {
    throw new Error("The current draft changed while opening another manuscript. It has been retained; choose the document again when ready.");
  }

  documentPath = data.path;
  documentSha = data.sha;
  documentIsLocal = data.local === true;
  localStorage.setItem("lilamaya-editor-document-path", documentPath);

  renderDocumentSelector(availableDocuments);

  if (richEditor) {
    await richEditor.destroy();
    richEditor = null;
  }

  const editorRoot = document.querySelector("#codemirror-editor");

  richEditor = await createLilamayaEditor(
    editorRoot,
    data.content,
    {
      documentType: documentPath.split("/")[1],
      onRequestImage: handleImageInsertion,
      imageSourcePrefix: (() => {
        const standalone = documentPath.match(/^content\/fragments\/([a-z0-9-]+)\.md$/i);
        return standalone ? `/images/fragments/${standalone[1]}/` : "images/";
      })(),
      imageBaseUrl: (() => {
        const permalink = availableDocuments.find(item => item.path === documentPath)?.permalink;
        if (typeof permalink !== "string" || !/^\/(?!\/)/.test(permalink) || /[\s\\?#]/.test(permalink)) return "";
        try {
          const url = new URL(permalink, window.location.origin);
          return url.origin === window.location.origin ? url.pathname : "";
        } catch { return ""; }
      })()
    }
  );

  window.__lilamayaRichEditor = richEditor;

  // Display the actual title of the currently loaded document.
  const documentTitle =
    data.title || data.metadata?.fields?.title ||
    availableDocuments.find(item => item.path === documentPath)?.title ||
    documentPath.split("/").filter(Boolean).pop().replace(/\.md$/, "").replace(/-/g, " ");

  const titlePanel = document.createElement("div");
  titlePanel.className = "lilamaya-document-title-panel";

  const titleRow = document.createElement("div");
  titleRow.className = "lilamaya-document-title-row";

  const titleElement = document.createElement("h2");
  titleElement.className = "lilamaya-document-title";
  titleElement.textContent = documentTitle;

  const searchToggle = document.createElement("button");
  searchToggle.type = "button";
  searchToggle.className = "lilamaya-title-search-toggle";
  searchToggle.setAttribute("aria-label", "Find in this document");
  searchToggle.setAttribute("title", "Find in this document");
  searchToggle.setAttribute("aria-expanded", "false");
  searchToggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="10.8" cy="10.8" r="6.4"></circle><path d="m15.5 15.5 4.2 4.2"></path></svg>';
  searchToggle.addEventListener("click", () => {
    const panel = titlePanel.querySelector(".lilamaya-search-panel");
    if (panel && !panel.hidden) {
      richEditor.closeSearch();
    } else {
      richEditor.openSearch();
      searchToggle.setAttribute("aria-expanded", "true");
    }
  });

  titleRow.append(titleElement, searchToggle);

  const titleMeta = document.createElement("div");
  titleMeta.className = "lilamaya-document-title-meta";
  const writingType =
    documentPath.startsWith("content/essays/") ? "ESSAY" :
    documentPath.startsWith("content/fragments/") ? "FRAGMENT" :
    documentPath.startsWith("content/paintings/") ? "PAINTING" :
    null;

  titleMeta.textContent = writingType
    ? `WRITINGS · ${writingType}`
    : sectionForPath(documentPath).toUpperCase();

  titlePanel.append(titleRow, titleMeta);
  deleteView?.destroy();deleteView=null;
  metadataView?.destroy();
  socialCardEpoch++;socialCardBusy=false;socialCardResult=data.socialCard||null;
  metadataEdits={};metadataType=data.metadata?.type||null;metadataHeroAsset=data.metadata?.heroAsset||null;
  const metadataPanel = createMetadataPanel(document, data.metadata,
    availableDocuments.find(item => item.path === documentPath)?.permalink, window.location.origin,
    {onChange:updateMetadata,heroContext:{documentPath,apiBase,onAsset:asset=>{metadataHeroAsset=asset;}},loadThemes:loadMetadataThemes,mountThemes:(options)=>mountThemeManager(document,{...options,apiBase,
      beforeMutation:({operation,usage})=>{
        if(documentLoading||pendingSave||saveSafety?.state().busy)throw Error('Wait for the current load or save before managing global themes.');
        if(operation==='rename'&&(usage?.[metadataType]||[]).some(item=>item.path===documentPath))throw Error('This rename would rewrite the open manuscript. Preserve and save its draft, then review the rename from the creation form after leaving this document. No changes were made.');
      }})});
  metadataView=metadataPanel;
  if(metadataPanel)deleteView=mountDeleteControl(document,metadataPanel.panel,{type:data.metadata.type,path:documentPath,reason:deletionBlocked,prepare:prepareDeletion,confirm:confirmDeletion});

  richEditor.attachSearchPanel(titlePanel);
  const formattingToolbar = editorRoot.querySelector(":scope > .lilamaya-toolbar");
  if (!formattingToolbar) {
    throw new Error("Writing Desk formatting toolbar was not found.");
  }
  editorRoot.insertBefore(formattingToolbar, editorRoot.firstChild);
  editorRoot.insertBefore(titlePanel, formattingToolbar.nextSibling);
  if (metadataPanel) editorRoot.insertBefore(metadataPanel.utility, formattingToolbar);

  // Keep the sticky title immediately beneath the actual toolbar height.
  const updateTitleOffset = () => {
    const creationToolbar = document.querySelector(".author-bar");
    const creationToolbarHeight = creationToolbar
      ? creationToolbar.getBoundingClientRect().height
      : 42;

    formattingToolbar.style.setProperty(
      "top",
      `${creationToolbarHeight}px`,
      "important"
    );

    const toolbarTop = creationToolbarHeight;
    const toolbarHeight = formattingToolbar.getBoundingClientRect().height;
    titlePanel.style.setProperty(
      "--lilamaya-title-sticky-top",
      `${toolbarTop + toolbarHeight}px`
    );
  };
  updateTitleOffset();
  const titleToolbarObserver = new ResizeObserver(updateTitleOffset);
  titleToolbarObserver.observe(formattingToolbar);
  window.addEventListener("resize", updateTitleOffset, { passive: true });

  cleanupStickyTitle = () => {
    titleToolbarObserver.disconnect();
    window.removeEventListener("resize", updateTitleOffset);
  };

  renderDocumentConnections(data.connections || []);
  savedContent = data.content;
  savedConnections = JSON.stringify(collectDocumentConnections());
  acknowledgedDiskKnown = true;
  saveValidationError = null;
  } finally {
    documentLoading = false;
    renderSaveStatus();
  }
}

function sectionForPath(path) {
  if (path.startsWith("content/people/")) return "People";
  if (path.startsWith("content/works/")) return "Works";
  if (path.startsWith("content/ideas/")) return "Ideas";
  if (path.startsWith("content/traditions/")) return "Traditions";
  if (path.startsWith("content/places/")) return "Places";
  if (path.startsWith("content/journeys/")) return "Journeys";

  if (
    path.startsWith("content/essays/") ||
    path.startsWith("content/fragments/") ||
    path.startsWith("content/paintings/")
  ) return "Writings";

  return "Other";
}

function renderDocumentSelector(documents) {
  const selector = document.querySelector("#document-selector");

  if (newEssayMode || newEntryMode) {
    selector.hidden = true;
    return;
  }

  selector.hidden = false;

  const groups = {
    People: [],
    Works: [],
    Ideas: [],
    Traditions: [],
    Places: [],
    Journeys: [],
    Writings: []
  };

  for (const item of documents) {
    const section = sectionForPath(item.path);

    if (groups[section]) {
      groups[section].push(item);
    }
  }

  for (const section of Object.keys(groups)) {
    groups[section].sort((a, b) =>
      a.title.localeCompare(b.title)
    );
  }

  selector.innerHTML = "";

  for (const [section, items] of Object.entries(groups)) {
    if (!items.length) continue;

    const wrapper = document.createElement("div");
    wrapper.className = "document-selector-dropdown";

    const heading = document.createElement("div");
    heading.className = "document-selector-heading";
    heading.textContent = section;

    const select = document.createElement("select");
    select.className = "document-selector-select";
    select.setAttribute("aria-label", section);

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = `Choose ${section.toLowerCase()}…`;
    placeholder.disabled = true;
    placeholder.selected = !items.some(item => item.path === documentPath);
    select.appendChild(placeholder);

    if (section === "Writings") {
      const writingGroups = [
        ["ESSAYS", "content/essays/"],
        ["FRAGMENTS", "content/fragments/"],
        ["PAINTINGS", "content/paintings/"]
      ];

      for (const [label, prefix] of writingGroups) {
        const matchingItems = items
          .filter(item => item.path.startsWith(prefix))
          .sort((a, b) =>
            a.title.localeCompare(b.title, undefined, {
              sensitivity: "base"
            })
          );

        if (!matchingItems.length) continue;

        const group = document.createElement("optgroup");
        group.label = label;

        for (const item of matchingItems) {
          const option = document.createElement("option");
          option.value = item.path;
          option.textContent = item.title;
          option.selected = item.path === documentPath;
          group.appendChild(option);
        }

        select.appendChild(group);
      }
    } else {
      for (const item of items) {
        const option = document.createElement("option");
        option.value = item.path;
        option.textContent = item.title;
        option.selected = item.path === documentPath;
        select.appendChild(option);
      }
    }

    select.addEventListener("change", async () => {
      if (!select.value) return;

      if (!confirmDiscardUnsavedChanges()) {
        renderDocumentSelector(availableDocuments);
        return;
      }

      try {
        await loadDocument(select.value);
        showEditorScreen();

        for (const otherSelect of document.querySelectorAll(
          ".document-selector-select"
        )) {
          if (otherSelect !== select) {
            const otherItems = groups[
              otherSelect.getAttribute("aria-label")
            ];

            if (otherItems) {
              const current = otherItems.find(
                item => item.path === documentPath
              );

              otherSelect.value = current ? current.path : "";
            }
          }
        }
      } catch (error) {
        console.error("Lilamaya Document Load Error:", error);
        alert(error.message);
      }
    });

    wrapper.appendChild(heading);
    wrapper.appendChild(select);
    selector.appendChild(wrapper);
  }
}

async function loadCreationThemes(kind = "essays") {
 const stem={essays:'essay',fragments:'fragment',paintings:'painting'}[kind];
 return mountThemeManager(document,{kind,apiBase,select:document.querySelector(`#new-${stem}-themes`),addThemeButton:document.querySelector(`#add-${stem}-theme`)});
}

async function loadDocumentList() {
  const response = await fetch(apiBase + "/api/documents");

  if (!response.ok) {
    throw new Error(`Document list failed: ${response.status}`);
  }

  const data = await response.json();

  if (!data.ok) {
    throw new Error(data.error || "Document list failed");
  }

  availableDocuments = data.documents || [];
  renderDocumentSelector(availableDocuments);
}

function saveSubmissionIdentity({path, revision, markdown, connections, metadata}) {
  return JSON.stringify({path, revision, markdown, connections, metadata});
}

async function saveDocument() {
  initializeSaveSafety();
  if (deleteBusy || deleteUncertain || documentLoading || !richEditor || !saveSafety.state().canRetry) {
    renderSaveStatus();
    return;
  }
  if(updateDuplicateWarnings("#document-connection-list")) {
    saveValidationError = "Resolve duplicate connections before saving.";
    renderSaveStatus();
    return;
  }
  saveValidationError = null;
  lastSaveHttpStatus = null;
  let confirmedYearChange = null;
  try {
    if (metadataType && Object.hasOwn(metadataEdits, "date")) {
      const proposed = captureUnsavedDraft();
      // Serialization failures retain the existing Draft Safety handling below.
      if (!proposed.serializationError && typeof proposed.markdown === "string") {
        const originalDate = metadataPatch.dateString(proposed.metadata.baseFrontmatter);
        const proposedDate = metadataPatch.dateString(proposed.markdown);
        if (!metadataPatch.validDate(originalDate) || !metadataPatch.validDate(proposedDate)) {
          throw new Error("The original or proposed date cannot be safely verified. Your draft is retained.");
        }
        if (originalDate.slice(0, 4) !== proposedDate.slice(0, 4)) {
          const reviewed = {identity:saveSubmissionIdentity(proposed), editor:richEditor};
          if (!window.confirm(`Confirm calendar year change.\n\nOriginal year: ${originalDate.slice(0, 4)}\nProposed year: ${proposedDate.slice(0, 4)}\n\nOriginal date: ${originalDate}\nProposed date: ${proposedDate}\n\nSave this exact date? Existing revision and URL safeguards still apply. Cancel keeps your draft.`)) {
            renderSaveStatus();
            return;
          }
          confirmedYearChange = reviewed;
        }
      }
    }
  } catch (error) {
    saveValidationError = error.message;
    renderSaveStatus();
    return;
  }
  try {
    await saveSafety.save(async draft=>{
      if (confirmedYearChange && (richEditor !== confirmedYearChange.editor ||
          saveSubmissionIdentity(draft) !== confirmedYearChange.identity)) {
        return {ok:false,status:422,body:{
          error:"The draft changed after year confirmation. Review the date and Save again.",
          save:{kind:"failure",publication:"none",recovery:{required:false}}
        }};
      }
      pendingSave = draft;
      pendingEditor = richEditor;
      renderSaveStatus();
      const response=await fetch(apiBase+"/api/save",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({path:draft.path,content:draft.markdown,sha:draft.revision,connections:draft.connections,metadata:draft.metadata})});
      lastSaveHttpStatus = response.status;
      return {ok:response.ok,status:response.status,body:await response.json()};
    });
  } finally {
    pendingSave = null;
    pendingEditor = null;
    renderSaveStatus();
  }
}


async function beginNewEssay() {
  const newEssayForm = document.querySelector("#new-essay-form");
  const documentSelector = document.querySelector("#document-selector");
  const editorActions = document.querySelector(".editor-actions");
  const codeMirrorEditor = document.querySelector("#codemirror-editor");

  const titleInput = document.querySelector("#new-essay-title");
  const introductionInput = document.querySelector("#new-essay-introduction");
  const themeStem={essays:"essay",fragments:"fragment",paintings:"painting"}[newDocumentType];
  const themesSelect = document.querySelector(`#new-${themeStem}-themes`);
  const imageInput = document.querySelector("#new-essay-image");
  const beginButton = document.querySelector("#begin-new-essay");

  const title = titleInput.value.trim();
  const introduction = newDocumentType === "fragments" ? "" : introductionInput.value.trim();
  const type = newDocumentType;
  const themes = [...themesSelect.selectedOptions].map(option => option.value);
  const artist = document.querySelector("#new-painting-artist").value.trim();
  const year = document.querySelector("#new-painting-year").value.trim();
  const imageFile = type === "fragments" ? null : imageInput.files[0] || null;

  if (type === "paintings" && (!artist || !/^\d{4}$/.test(year) || !imageFile)) {
    alert("Please provide an artist, four-digit year and hero image for the painting.");
    return;
  }

  const extension = imageFile
    ? imageFile.name.split(".").pop().toLowerCase()
    : null;

  const allowedExtensions = ["jpg", "jpeg", "png", "webp"];

  if (imageFile && !allowedExtensions.includes(extension)) {
    alert("Please choose a JPG, JPEG, PNG, or WebP image.");
    imageInput.focus();
    return;
  }

  const maxImageSize = 8 * 1024 * 1024;

  if (imageFile && imageFile.size > maxImageSize) {
    alert("Please choose an image smaller than 8 MiB.");
    imageInput.focus();
    return;
  }

  if (!title) {
    const titleError = document.querySelector("#new-essay-title-error");
    titleError.textContent = "Please enter a title for this document.";
    titleError.hidden = false;
    titleInput.focus();
    return;
  }

  const documentConnections = document.querySelector("#document-connections");

  const previousScreen = {
    selectorHidden: documentSelector.hidden,
    actionsHidden: editorActions.hidden,
    editorHidden: codeMirrorEditor.hidden,
    connectionsHidden: documentConnections.hidden
  };

  // Hide the previously loaded document while the new one is prepared.
  documentSelector.hidden = true;
  editorActions.hidden = true;
  codeMirrorEditor.hidden = true;
  documentConnections.hidden = true;

  beginButton.disabled = true;
  beginButton.textContent = "Creating…";

  let createdPath = null;
  try {
    const endpoint = {essays: "/api/new-essay", fragments: "/api/new-fragment", paintings: "/api/new-painting"}[type];
    const response = await fetch(apiBase + endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title,
        ...(type === "fragments" ? {} : {introduction}),
        themes,
        ...(type === "paintings" ? {artist, year} : {}),
        date: (() => {
          const now = new Date();
          const year = now.getFullYear();
          const month = String(now.getMonth() + 1).padStart(2, "0");
          const day = String(now.getDate()).padStart(2, "0");

          return `${year}-${month}-${day}`;
        })()
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        result.error || `Essay creation failed: ${response.status}`
      );
    }

    createdPath = result.path;
    if (imageFile) {
      beginButton.textContent = "Uploading image…";

      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => {
          const dataUrl = reader.result;
          resolve(dataUrl.split(",")[1]);
        };

        reader.onerror = () => {
          reject(new Error("Could not read the selected image."));
        };

        reader.readAsDataURL(imageFile);
      });

      const imageResponse = await fetch(apiBase + "/api/upload-image", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          path: result.path.replace(
            /index\.md$/,
            `hero.${extension}`
          ),
          content: base64,
          local: result.local === true
        })
      });

      const imageResult = await imageResponse.json();

      if (!imageResponse.ok) {
        throw new Error(
          imageResult.error ||
          `Image upload failed: ${imageResponse.status}`
        );
      }
    }

    await loadDocumentList();
    await loadDocument(result.path);
    showEditorScreen();

  } catch (error) {
    console.error("New Essay error:", error);

    // A failed optional upload must not hide the already-created local draft.
    if (createdPath) {
      try {
        await loadDocumentList();
        await loadDocument(createdPath);
        showEditorScreen();
        alert(`The local draft was created, but setup did not complete: ${error.message}. No draft was deleted. Use the library to reopen it; do not recreate it.`);
        return;
      } catch { /* Preserve the original error and restore the previous display. */ }
    }
    // Restore the previous screen if creation or loading fails.
    documentSelector.hidden = previousScreen.selectorHidden;
    editorActions.hidden = previousScreen.actionsHidden;
    codeMirrorEditor.hidden = previousScreen.editorHidden;
    documentConnections.hidden = previousScreen.connectionsHidden;

    alert(error.message);

  } finally {
    beginButton.disabled = false;
    beginButton.textContent = "Begin Writing";
  }
}

function updateDuplicateWarnings(listSelector) {
  const rows = [
    ...document.querySelectorAll(`${listSelector} .entry-connection-row`)
  ];

  const counts = new Map();

  for (const row of rows) {
    const value = row.querySelector(".entry-connection-target").value;
    if (value) counts.set(value, (counts.get(value) || 0) + 1);
  }

  let hasDuplicates = false;

  for (const row of rows) {
    const value = row.querySelector(".entry-connection-target").value;
    const duplicate = value && counts.get(value) > 1;
    const warning = row.querySelector(".entry-connection-warning");

    row.classList.toggle("has-duplicate-target", Boolean(duplicate));
    warning.hidden = !duplicate;
    warning.textContent = duplicate
      ? "This entry is connected more than once. Choose a different target or remove this connection."
      : "";

    if (duplicate) hasDuplicates = true;
  }

  return hasDuplicates;
}

function addEntryConnectionRow(
  listSelector = "#entry-connection-list",
  connection = {}
) {
  const list = document.querySelector(listSelector);

  const row = document.createElement("div");
  row.className = "entry-connection-row";

  const target = document.createElement("select");
  target.className = "entry-connection-target";
  target.setAttribute("aria-label", "Connected entry");

  const relation = document.createElement("select");
  relation.className = "entry-connection-relation";
  relation.setAttribute("aria-label", "Relationship");

  const relations = [
    ["authored", "Authored"],
    ["authored-by", "Authored by"],
    ["explores", "Explores"],
    ["influenced", "Influenced"],
    ["influenced-by", "Influenced by"],
    ["disagrees-with", "Disagrees with"],
    ["belongs-to", "Belongs to"],
    ["related-to", "Related to"]
  ];

  for (const [value, label] of relations) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    relation.appendChild(option);
  }

  relation.value = connection.relation || "related-to";

  const sectionOrder = [
    "People",
    "Works",
    "Ideas",
    "Traditions",
    "Places",
    "Journeys",
    "Writings"
  ];

  const currentEntryTarget = listSelector === "#document-connection-list"
    ? availableDocuments.find(item => item.path === documentPath)?.permalink
    : null;

  const orderedDocuments = availableDocuments
    .filter(item => item.permalink)
    .sort((a, b) => {
      const sectionA = sectionOrder.indexOf(sectionForPath(a.path));
      const sectionB = sectionOrder.indexOf(sectionForPath(b.path));

      if (sectionA !== sectionB) return sectionA - sectionB;

      return a.title.localeCompare(b.title);
    });

  function permittedSections(relationValue) {
    if (relationValue === "authored") {
      return ["Works", "Writings"];
    }

    if (relationValue === "authored-by") {
      return ["People"];
    }

    if (relationValue === "belongs-to") {
      return ["Journeys"];
    }

    return sectionOrder;
  }

  function populateTargets(selectedTarget = "") {
    const permitted = permittedSections(relation.value);

    target.innerHTML = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose an entry…";
    target.appendChild(placeholder);

    for (const item of orderedDocuments) {
      const section = sectionForPath(item.path);

      if (!permitted.includes(section)) continue;

      const option = document.createElement("option");
      option.value = item.permalink;

      option.textContent = `${section} — ${item.title}`;

      if (option.value === currentEntryTarget) continue;

      target.appendChild(option);
    }

    // Preserve an existing target only if it remains valid.
    if (
      selectedTarget &&
      ![...target.options].some(option => option.value === selectedTarget)
    ) {
      const matchingDocument = orderedDocuments.find(
        item => item.permalink === selectedTarget
      );

      if (
        matchingDocument &&
        permitted.includes(sectionForPath(matchingDocument.path))
      ) {
        const option = document.createElement("option");
        option.value = selectedTarget;
        option.textContent =
          `${sectionForPath(matchingDocument.path)} — ${matchingDocument.title}`;
        target.appendChild(option);
      }
    }

    target.value = selectedTarget || "";
  }

  populateTargets(connection.target || "");

  target.addEventListener("change", () => {
    relationshipNotice.textContent = "";
    updateDuplicateWarnings(listSelector);
  });

  relation.addEventListener("change", () => {
    const previousTarget = target.value;
    populateTargets(previousTarget);

    if (previousTarget && !target.value) {
      relationshipNotice.textContent =
        "This relationship type does not allow the selected target. Please choose another entry.";
    } else {
      relationshipNotice.textContent = "";
    }

    updateDuplicateWarnings(listSelector);
  });

  const basis = document.createElement("select");
  basis.className = "entry-connection-basis";
  basis.setAttribute("aria-label", "Relationship basis");

  for (const [value, label] of [
    ["documented", "Documented"],
    ["interpretive", "Interpretive"]
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    basis.appendChild(option);
  }

  basis.value = connection.basis || "interpretive";

  const note = document.createElement("input");
  note.type = "text";
  note.className = "entry-connection-note";
  note.placeholder = "Optional note";
  note.setAttribute("aria-label", "Connection note");
  note.value = connection.note || "";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "entry-connection-remove";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => {
    row.remove();
    updateDuplicateWarnings(listSelector);
  });

  const duplicateWarning = document.createElement("div");
  duplicateWarning.className = "entry-connection-warning";
  duplicateWarning.setAttribute("role", "status");
  duplicateWarning.hidden = true;

  const relationshipNotice = document.createElement("div");
  relationshipNotice.className = "entry-connection-notice";
  relationshipNotice.setAttribute("role", "status");

  row.append(
    target,
    relation,
    basis,
    note,
    remove,
    duplicateWarning,
    relationshipNotice
  );

  list.appendChild(row);
  updateDuplicateWarnings(listSelector);
}

function renderDocumentConnections(connections = []) {
  const panel = document.querySelector("#document-connections");
  const list = document.querySelector("#document-connection-list");

  list.innerHTML = "";

  for (const connection of connections) {
    addEntryConnectionRow("#document-connection-list", connection);
  }

  panel.hidden = false;
}

function collectDocumentConnections() {
  return [
    ...document.querySelectorAll(
      "#document-connection-list .entry-connection-row"
    )
  ].map(row => ({
    target: row.querySelector(".entry-connection-target").value,
    relation: row.querySelector(".entry-connection-relation").value,
    basis: row.querySelector(".entry-connection-basis").value,
    note: row.querySelector(".entry-connection-note").value.trim()
  })).filter(connection => connection.target);
}

function hasUnsavedChanges() {
  if(deleteBusy||deleteUncertain)return true;
  if(saveSafety && (saveSafety.state().issue || saveSafety.state().busy))return true;
  return hasUnsavedBufferChanges();
}


function confirmDiscardUnsavedChanges() {
  if(deleteBusy||deleteUncertain)return false;
  if(saveSafety && !saveSafety.canNavigate())return false;
  if (!hasUnsavedChanges()) return true;

  return window.confirm(
    "You have unsaved changes to this document. " +
    "Discard them and continue?"
  );
}

async function createNewEntry() {
  const button = document.querySelector("#create-entry");
  const status = document.querySelector("#create-entry-status");
  status.textContent = "";

  const payload = {
    type: document.querySelector("#entry-type").value,
    title: document.querySelector("#entry-title").value.trim(),
    description: document.querySelector("#entry-description").value.trim(),
    stage: document.querySelector("#entry-stage").value.trim() || "seed",
    date: document.querySelector("#entry-date").value,
    body: document.querySelector("#entry-body").value
  };

  if (!payload.title) {
    const titleInput = document.querySelector("#entry-title");
    const titleError = document.querySelector("#entry-title-error");

    titleError.textContent = "Please enter a title for this entry.";
    titleError.hidden = false;
    titleInput.focus();
    return;
  }

  if (updateDuplicateWarnings("#entry-connection-list")) {
    status.textContent = "Resolve duplicate connections before creating this entry.";
    return;
  }

  payload.connections = [
    ...document.querySelectorAll(
      "#entry-connection-list .entry-connection-row"
    )
  ].map(row => ({
    target: row.querySelector(".entry-connection-target").value,
    relation: row.querySelector(".entry-connection-relation").value,
    basis: row.querySelector(".entry-connection-basis").value,
    note: row.querySelector(".entry-connection-note").value.trim()
  })).filter(connection => connection.target);

  button.disabled = true;
  button.textContent = "Creating…";

  try {
    const response = await fetch(apiBase + "/api/new-entry?local=1", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || `Creation failed: ${response.status}`);
    }

    newEntryMode = false;
    document.querySelector("#new-entry-form").hidden = true;
    document.querySelector("#document-selector").hidden = false;
    document.querySelector(".editor-actions").hidden = false;
    document.querySelector("#codemirror-editor").hidden = false;

    document.querySelector("#entry-connection-list").innerHTML = "";

    await loadDocumentList();
    await loadDocument(result.path);
    showEditorScreen();

    renderSaveStatus();

  } catch (error) {
    console.error("New Entry Error:", error);
    status.textContent = error.message;

  } finally {
    button.disabled = false;
    button.textContent = "Create Entry";
  }
}

async function loadEditor() {
  initializeSaveSafety();
  const newEssayForm = document.querySelector("#new-essay-form");
  const newEntryForm = document.querySelector("#new-entry-form");

  const newEssayButton = [...document.querySelectorAll(
    ".author-bar button"
  )].find(button => button.textContent.trim() === "New Essay");

  const newEntryButton = document.querySelector("#new-entry-button");

  const documentSelector = document.querySelector("#document-selector");
  const editorActions = document.querySelector(".editor-actions");
  const codeMirrorEditor = document.querySelector("#codemirror-editor");


  const editButton = document.querySelector("#edit-button");

  if (editButton) {
    editButton.addEventListener("click", () => {
      if (!confirmDiscardUnsavedChanges()) return;
      showLibraryScreen();
    });
  }

  const essayTitleInput = document.querySelector("#new-essay-title");
  const essayTitleError = document.querySelector("#new-essay-title-error");

  essayTitleInput.addEventListener("input", () => {
    if (essayTitleInput.value.trim()) {
      essayTitleError.textContent = "";
      essayTitleError.hidden = true;
    }
  });

  const creationButtons = [[newEssayButton, "essays", "Essay"],
    [[...document.querySelectorAll(".author-bar button")].find(button => button.textContent.trim() === "New Fragment"), "fragments", "Fragment"],
    [[...document.querySelectorAll(".author-bar button")].find(button => button.textContent.trim() === "New Painting"), "paintings", "Painting"]];
  for (const [button, type, label] of creationButtons) {
    if (!button) continue;
    button.addEventListener("click", async () => {
      if ((type === "fragments" && !fragmentThemesLoaded) || (type === "paintings" && !paintingThemesLoaded)) {
        button.disabled = true;
        try { await loadCreationThemes(type); if(type === "fragments") fragmentThemesLoaded=true; else paintingThemesLoaded=true; }
        catch (error) { alert(label + " themes could not be loaded: " + error.message); return; }
        finally { button.disabled = false; }
      }
      if (!confirmDiscardUnsavedChanges()) return;
      newDocumentType = type;
      essayTitleError.textContent = "";
      essayTitleError.hidden = true;
      document.querySelector("#new-document-heading").textContent = `Begin a New ${label}`;
      document.querySelector("#painting-theme-fields").hidden = type !== "paintings";
      document.querySelector("#fragment-theme-fields").hidden = type !== "fragments";
      document.querySelector("#new-essay-introduction").hidden = type === "fragments";
      document.querySelector('label[for="new-essay-introduction"]').hidden = type === "fragments";
      document.querySelector("#new-painting-fields").hidden = type !== "paintings";
      document.querySelector("#essay-theme-fields").hidden = type !== "essays";
      const essayThemes = document.querySelector("#new-essay-themes");
      essayThemes.hidden = type !== "essays";
      document.querySelector('label[for="new-essay-themes"]').hidden = type !== "essays";
      document.querySelector("#add-essay-theme").hidden = type !== "essays";
      document.querySelector("#new-essay-image").hidden = type === "fragments";
      document.querySelector("#new-document-image-label").textContent = type === "paintings" ? "Hero image (required)" : type === "fragments" ? "Insert body images after creating the fragment." : "Image (optional)";
      newEssayMode = true;
      newEntryMode = false;
      newEntryForm.hidden = true;
      newEssayForm.hidden = false;
      document.querySelector("#document-connections").hidden = true;
      documentSelector.hidden = true;
      editorActions.hidden = true;
      codeMirrorEditor.hidden = true;
      essayTitleInput.focus();
      window.scrollTo({top: newEssayForm.offsetTop - 30, behavior: "smooth"});
    });
  }

  const entryTitleInput = document.querySelector("#entry-title");
  const entryTitleError = document.querySelector("#entry-title-error");

  entryTitleInput.addEventListener("input", () => {
    if (entryTitleInput.value.trim()) {
      entryTitleError.textContent = "";
      entryTitleError.hidden = true;
    }
  });

  if (newEntryButton) {
    newEntryButton.addEventListener("click", () => {
      if (!confirmDiscardUnsavedChanges()) return;

      const titleError = document.querySelector("#entry-title-error");
      titleError.textContent = "";
      titleError.hidden = true;

      newEntryMode = true;
      newEssayMode = false;
      newEssayForm.hidden = true;
      newEntryForm.hidden = false;
      document.querySelector("#document-connections").hidden = true;
      documentSelector.hidden = true;
      editorActions.hidden = true;
      codeMirrorEditor.hidden = true;

      const date = new Date();
      const localDate = new Date(
        date.getTime() - date.getTimezoneOffset() * 60000
      ).toISOString().slice(0, 10);

      document.querySelector("#entry-date").value = localDate;
      document.querySelector("#entry-title").focus();

      window.scrollTo({
        top: newEntryForm.offsetTop - 30,
        behavior: "smooth"
      });
    });
  }

  document.querySelector("#cancel-new-essay").addEventListener(
    "click",
    showLibraryScreen
  );

  document.querySelector("#cancel-entry").addEventListener(
    "click",
    showLibraryScreen
  );

  document.querySelector("#add-entry-connection").addEventListener(
    "click",
    () => addEntryConnectionRow()
  );

  document.querySelector("#add-document-connection").addEventListener(
    "click",
    () => addEntryConnectionRow("#document-connection-list")
  );

  document.querySelector("#create-entry").addEventListener(
    "click",
    createNewEntry
  );

  document
    .querySelector("#save-editor")
    .addEventListener("click", saveDocument);

  document
    .querySelector("#preview-editor")
    .addEventListener("click", previewDocument);

  document
    .querySelector("#begin-new-essay")
    .addEventListener("click", beginNewEssay);

  try {
    await loadDocumentList();

    const savedDocumentPath = localStorage.getItem(
      "lilamaya-editor-document-path"
    );

    const initialDocumentPath = availableDocuments.some(
      item => item.path === savedDocumentPath
    )
      ? savedDocumentPath
      : defaultDocumentPath;

    await loadDocument(initialDocumentPath);
    await loadCreationThemes();
    showEditorScreen();
  } catch (error) {
    console.error("Lilamaya Editor Error:", error);
    alert(error.message);
  }
}

loadEditor();
