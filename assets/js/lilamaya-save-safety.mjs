// Browser-independent save state. No disk access, restoration, or reload actions.
export function createSaveSafety({readDraft, isDirty, render = () => {}, onSaved = () => {}, confirmResolution = () => false}) {
  let issue = null, busy = false, attempted = null, exported = null;
  const fingerprint = draft => JSON.stringify(draft);
  const state = () => ({busy, issue, canRetry: !busy && (!issue || (issue.kind === "failure" && issue.publication === "none"))});
  const notify = () => render(state());
  function classify(status, body = {}) {
    const save = body.save;
    const publication = ["none", "occurred", "unknown"].includes(save?.publication) ? save.publication : "unknown";
    const recovery = save?.recovery || {required: publication !== "none"};
    const kind = save?.kind === "recovery-conflict" || recovery.required || (status === 409 && publication !== "none")
      ? "recovery" : status === 409 ? "stale" : "failure";
    return {kind, publication, recovery, message: body.error || "The save was not confirmed. Preserve your draft before checking disk contents."};
  }
  async function save(send) {
    if (!state().canRetry) { notify(); return false; }
    busy = true; notify();
    try {
      attempted = readDraft();
      if (attempted.serializationError || typeof attempted.markdown !== "string") {
        issue = {kind:"failure", publication:"none", recovery:{required:false}, message:"Markdown could not be safely synchronized. Export the recovery snapshot; your editor buffer has not been discarded."};
        return false;
      }
      const response = await send(attempted);
      if (!response.ok) { issue = classify(response.status, response.body); return false; }
      if (!response.body || typeof response.body.sha !== "string") {
        issue = classify(0, {error:"The save response was incomplete. Disk state is unknown."}); return false;
      }
      onSaved(response.body, attempted);
      issue = null; attempted = null; exported = null;
      return true;
    } catch (error) {
      issue = classify(0, {error:"The save was not confirmed. Disk state is unknown; preserve your draft before retrying."});
      return false;
    } finally { busy = false; notify(); }
  }
  function captureExport() {
    const current = readDraft();
    return {current, fingerprint:fingerprint(current), text:JSON.stringify({format:"lilamaya-unsaved-draft-v1", draft:current, failedAttempt:attempted, saveIssue:issue},null,2)};
  }
  async function exportDraft(write) {
    // Mark only after the export/copy action succeeds; confirmation remains explicit.
    const payload = captureExport();
    await write(payload);
    exported = payload.fingerprint; notify(); return payload;
  }
  function acknowledgeResolution({draftPreserved, diskReviewed}) {
    if (busy || !issue || !draftPreserved || !diskReviewed || exported !== fingerprint(readDraft())) return false;
    if (!confirmResolution()) return false;
    issue = null; attempted = null; exported = null; notify(); return true;
  }
  function needsProtection() {
    if (busy || issue) return true;
    try { return isDirty(); } catch { return true; }
  }
  function canNavigate() { if (busy || issue) { notify(); return false; } return true; }
  function beforeUnload(event) {
    if (!needsProtection()) return;
    event.preventDefault(); event.returnValue = ""; return "";
  }
  notify();
  return {save, state, exportDraft, acknowledgeResolution, needsProtection, canNavigate, beforeUnload};
}

export function createSaveSafetyPanel(document, actions, {download, copy, resolve}) {
  const panel = document.createElement("section"); panel.hidden = false;
  panel.setAttribute("aria-label", "Unsaved manuscript protection");
  const message = document.createElement("p"); message.setAttribute("role","alert");
  message.setAttribute("aria-live","assertive"); message.setAttribute("aria-atomic","true");
  const explanation = document.createElement("p");
  const feedback = document.createElement("p"); feedback.setAttribute("role","status");
  const exported = document.createElement("input"); exported.type="checkbox";
  const reviewed = document.createElement("input"); reviewed.type="checkbox";
  const labels = [document.createElement("label"),document.createElement("label")];
  labels[0].append(exported, document.createTextNode(" I saved and opened the current exported draft, or verified its copied contents."));
  labels[1].append(reviewed, document.createTextNode(" I reviewed the disk and recovery situation using the single-writer procedure."));
  const button = (text, action) => {
    const e=document.createElement("button");e.type="button";e.textContent=text;
    e.addEventListener("click",async()=>{try{await action();}catch{feedback.textContent="Draft preservation did not complete. Keep this page open and try the download option.";}});return e;
  };
  panel.append(message,explanation,
    button("Download complete draft snapshot",download),button("Copy complete draft snapshot",copy),
    ...labels,button("Acknowledge preservation and review",()=>{
      if(resolve({draftPreserved:exported.checked,diskReviewed:reviewed.checked})) {
        exported.checked=false;reviewed.checked=false;
        feedback.textContent="Acknowledged. No disk changes or reload were performed. Your browser draft may still be unsaved.";
      } else feedback.textContent="First preserve the latest draft and complete both confirmations. Acknowledgment does not reload or restore anything.";
    }),feedback);
  actions.insertAdjacentElement("afterend",panel);
  return {render(state){
    panel.hidden=false;
    message.hidden=!state.issue;
    if(!state.issue){explanation.textContent="You can preserve a complete draft snapshot before reloading or leaving this manuscript.";return;}
    const i=state.issue;
    message.textContent=(i.kind==="stale"?"Save conflict: ":i.kind==="recovery"?"Recovery review required: ":"Save not completed: ")+i.message;
    explanation.textContent=i.publication==="none"
      ?"This save did not publish your draft. Another writer may have changed the disk. Preserve the current browser draft before reviewing or reloading."
      :"The document path may already have changed. Preserve your browser draft and inspect disk and recovery versions before retrying. Do not delete recovery locks.";
    if(i.recovery?.backupId) explanation.textContent+=" Backup reference: "+String(i.recovery.backupId).replace(/[^A-Za-z0-9._-]/g,"");
    if(i.recovery?.lockRetained) explanation.textContent+=" A manuscript recovery lock is retained; manual review is required.";
  }};
}
