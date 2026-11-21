import {appendThemeChoice} from './lilamaya-theme-picker.js';
export async function mountThemeManager(document, {kind="essays",apiBase,select,addThemeButton,selected=[],onChange=()=>{},beforeMutation=()=>{},autoAssignNew=true}={}) {
  if (!["essays", "fragments", "paintings"].includes(kind)) throw new Error("Unsupported theme collection");
  const notify=values=>{if(select.isConnected)onChange(values);};
  const isLocal = true;
  const stem = {essays:"essay",fragments:"fragment",paintings:"painting"}[kind];
  const endpoint = `/api/${stem}-themes`;
  const usageEndpoint = `/api/${stem}-theme-usage`;
  const docPlural = kind;
  const capitalize = value => { if(kind==="essays")return value; const [first,...rest]=Array.from(value); return first ? first.toUpperCase()+rest.join("") : value; };
  const response = await fetch(apiBase + endpoint);

  if (!response.ok) {
    throw new Error(`${kind} themes failed: ${response.status}`);
  }

  const data = await response.json();
  const themes = data.themes || [];
  const labels = new Map((isLocal ? data.themeOptions || [] : []).map(item => [item.value,item.label]));
  const labelFor = value => isLocal ? labels.get(value) || capitalize(value) : value;


  select.innerHTML = "";
  select.classList.add("theme-select-hidden");

  const picker = document.createElement("div");
  picker.className = "theme-picker";

  for (const theme of [...new Set([...themes,...selected])]) appendThemeChoice(document,{select,picker,theme,label:labelFor(theme),selected:selected.includes(theme),onChange:notify});

  select.parentNode.insertBefore(picker, select);
  if (isLocal && data.conflicts?.length) {
    const warning = document.createElement("p");
    warning.className = "entry-connection-warning"; warning.setAttribute("role", "alert");
    warning.textContent = "Case conflicts require review: " + data.conflicts.map(item => item.label).join(", ") + ". These themes cannot be selected until their stored spellings are reviewed.";
    select.insertAdjacentElement("afterend", warning);
  }



  const addThemeArea = document.createElement("div");
  addThemeArea.className = "add-theme-area";
  addThemeArea.hidden = true;

  const addThemeInput = document.createElement("input");
  addThemeInput.type = "text";
  addThemeInput.placeholder = "New theme";
  addThemeInput.className = "add-theme-input";

  const confirmThemeButton = document.createElement("button");
  confirmThemeButton.type = "button";
  confirmThemeButton.textContent = "Add";
  confirmThemeButton.className = "confirm-theme-button";

  const addThemeError = document.createElement("div");
  addThemeError.className = "entry-connection-warning";
  addThemeError.setAttribute("role", "alert");
  addThemeError.hidden = true;

  addThemeArea.appendChild(addThemeInput);
  addThemeArea.appendChild(confirmThemeButton);
  addThemeArea.appendChild(addThemeError);

  addThemeButton.insertAdjacentElement("afterend", addThemeArea);

  const manageThemes = document.createElement("details");
  manageThemes.className = "manage-themes";

  const manageSummary = document.createElement("summary");
  const manageCount = document.createElement("span");
  manageCount.textContent = `${themes.length} themes`;
  manageSummary.textContent = "Manage Themes ";
  manageSummary.appendChild(manageCount);

  const manageContent = document.createElement("div");
  manageContent.className = "manage-themes-content";

  const manageDescription = document.createElement("p");
  manageDescription.textContent =
    (isLocal ? `Rename themes across the collection and ${docPlural}, or remove unused themes from the collection.` : "Rename themes across the collection and essays, or remove them from the collection.");

  const manageList = document.createElement("div");
  manageList.className = "manage-themes-list";

  manageContent.appendChild(manageDescription);
  manageContent.appendChild(manageList);
  manageThemes.appendChild(manageSummary);
  manageThemes.appendChild(manageContent);

  addThemeArea.insertAdjacentElement("afterend", manageThemes);

  function renderManagedTheme(theme) {
    if ([...manageList.children].some(row => row.dataset.theme === theme)) {
      return;
    }

    const row = document.createElement("div");
    row.className = "manage-theme-row";
    row.dataset.theme = theme;

    const name = document.createElement("span");
    name.className = "manage-theme-name";
    name.textContent = labelFor(theme);

    const controls = document.createElement("div");
    controls.className = "manage-theme-controls";

    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.className = "rename-theme-button";
    renameButton.textContent = "Rename";

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "remove-theme-button";
    removeButton.textContent = "Remove";

    controls.appendChild(renameButton);
    controls.appendChild(removeButton);

    row.appendChild(name);
    row.appendChild(controls);
    manageList.appendChild(row);

    renameButton.addEventListener("click", () => {
      if (row.querySelector(".rename-theme-editor")) return;

      renameButton.disabled = true;
      removeButton.disabled = true;

      const editor = document.createElement("div");
      editor.className = "rename-theme-editor";

      const input = document.createElement("input");
      input.type = "text";
      input.className = "rename-theme-input";
      input.value = labelFor(theme);
      input.maxLength = 100;
      input.setAttribute("aria-label", `New name for ${labelFor(theme)}`);

      const message = document.createElement("p");
      message.className = "rename-theme-message";
      message.setAttribute("role", "status");

      const actions = document.createElement("div");
      actions.className = "remove-theme-actions";

      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "secondary-action";
      cancelButton.textContent = "Cancel";

      const previewButton = document.createElement("button");
      previewButton.type = "button";
      previewButton.className = "rename-theme-preview-button";
      previewButton.textContent = "Preview Rename";

      actions.appendChild(cancelButton);
      actions.appendChild(previewButton);

      editor.appendChild(input);
      editor.appendChild(message);
      editor.appendChild(actions);
      row.appendChild(editor);

      function closeEditor() {
        editor.remove();
        renameButton.disabled = false;
        removeButton.disabled = false;
      }

      cancelButton.addEventListener("click", closeEditor);

      input.addEventListener("keydown", event => {
        if (event.key === "Escape") closeEditor();
        if (event.key === "Enter") previewButton.click();
      });

      previewButton.addEventListener("click", async () => {
        const newTheme = isLocal ? capitalize(input.value.trim()) : input.value.trim();

        if (!newTheme) {
          message.textContent = "Please enter a theme name.";
          input.focus();
          return;
        }

        if (newTheme.length > 100) {
          message.textContent = "Theme names cannot exceed 100 characters.";
          input.focus();
          return;
        }

        if (newTheme === theme || (isLocal && newTheme === labelFor(theme))) {
          message.textContent = "The new name is identical to the current name.";
          input.focus();
          return;
        }

        if (themes.some(value => value !== theme && (isLocal ? value.toLowerCase() === newTheme.toLowerCase() : value === newTheme))) {
          message.textContent = "A theme with that name already exists.";
          input.focus();
          return;
        }

        previewButton.disabled = true;
        cancelButton.disabled = true;
        input.disabled = true;
        message.textContent = `Checking which ${docPlural} use this theme…`;

        try {
          const usageResponse = await fetch(
            `${apiBase}${usageEndpoint}?theme=${encodeURIComponent(theme)}${isLocal ? "&newTheme="+encodeURIComponent(newTheme) : ""}`
          );
          const usage = await usageResponse.json();
          const affectedItems = usage[docPlural] || [];

          if (!usageResponse.ok) {
            throw new Error(usage.error || "Could not check theme usage.");
          }

          beforeMutation({kind,operation:"rename",theme,newTheme,usage});
          message.textContent = usage.count === 0
            ? `Rename “${labelFor(theme)}” to “${newTheme}”? No ${docPlural} currently use this theme.`
            : `Rename “${labelFor(theme)}” to “${newTheme}”? This will update ${usage.count} ${stem}${usage.count === 1 ? "" : "s"} as well as the theme collection.`;

          if (affectedItems.length) {
            const essayList = document.createElement("ul");

            for (const essay of affectedItems) {
              const item = document.createElement("li");
              item.textContent = essay.title;
              essayList.appendChild(item);
            }

            editor.insertBefore(essayList, actions);
          }

          actions.replaceChildren();

          const finalCancelButton = document.createElement("button");
          finalCancelButton.type = "button";
          finalCancelButton.className = "secondary-action";
          finalCancelButton.textContent = "Cancel";

          const confirmButton = document.createElement("button");
          confirmButton.type = "button";
          confirmButton.className = "rename-theme-confirm-button";
          confirmButton.textContent = "Rename Theme";

          actions.appendChild(finalCancelButton);
          actions.appendChild(confirmButton);

          finalCancelButton.addEventListener("click", closeEditor);
          let approveUrlChange = null;
          if (isLocal && usage.count > 0 && theme.toLowerCase() !== newTheme.toLowerCase()) {
            const warning = document.createElement("label");
            approveUrlChange = document.createElement("input"); approveUrlChange.type = "checkbox";
            warning.append(approveUrlChange, document.createTextNode(" I explicitly approve changing this assigned theme name and its possible public URL. Existing direct links may stop working; no redirects are created."));
            editor.insertBefore(warning, actions); confirmButton.disabled = true;
            approveUrlChange.addEventListener("change", () => { confirmButton.disabled = !approveUrlChange.checked; });
          }

          confirmButton.addEventListener("click", async () => {
            confirmButton.disabled = true;
            finalCancelButton.disabled = true;
            message.textContent = `Updating the theme collection and ${docPlural}…`;

            try {
              beforeMutation({kind,operation:"rename",theme,newTheme,usage});
              const response = await fetch(
                apiBase + endpoint + "/rename",
                {
                  method: "POST",
                  headers: {"Content-Type": "application/json"},
                  body: JSON.stringify({
                    oldTheme: theme,
                    newTheme,
                    confirm: true,
                    ...(isLocal ? {revision:usage.revision, approveUrlChange:approveUrlChange?.checked === true} : {})
                  })
                }
              );

              const result = await response.json();

              if (!response.ok) {
                throw new Error(
                  result.error || `Theme rename failed: ${response.status}`
                );
              }

              // Preserve the user's current theme selections.
              const selectedThemes = new Set(
                [...select.selectedOptions].map(option => option.value)
              );

              const option = [...select.options].find(
                item => item.value === theme
              );

              if (option) {
                option.value = newTheme;
                option.textContent = isLocal ? capitalize(newTheme) : newTheme;
                option.selected = selectedThemes.has(theme);
              }

              const pickerButton = [...picker.querySelectorAll(".theme-choice")]
                .find(button => isLocal ? button.dataset.themeValue === theme : button.textContent === theme);

              if (pickerButton) {
                labels.set(newTheme, isLocal ? result.label : newTheme);
                pickerButton.textContent = labelFor(newTheme);
                pickerButton.dataset.themeValue = newTheme;
                pickerButton.classList.toggle(
                  "selected",
                  selectedThemes.has(theme)
                );
                pickerButton.setAttribute(
                  "aria-pressed",
                  String(selectedThemes.has(theme))
                );
              }

              // Keep the local collection in sync for duplicate checks.
              const themeIndex = themes.indexOf(theme);
              if (themeIndex !== -1) themes[themeIndex] = newTheme;
              themes.sort((a, b) => a.localeCompare(b));

              row.dataset.theme = newTheme;
              name.textContent = labelFor(newTheme);

              manageList.removeChild(row);
              renderManagedTheme(newTheme);
              manageCount.textContent = `${result.themes.length} themes`;
              notify([...select.selectedOptions].map(o=>o.value));
              changed({oldTheme:theme,newTheme});

            } catch (error) {
              console.error("Essay theme rename error:", error);
              message.textContent = error.message;
              confirmButton.remove();
              finalCancelButton.textContent = "Close";
              finalCancelButton.disabled = false;
              finalCancelButton.onclick = closeEditor;
            }
          });

        } catch (error) {
          console.error("Essay theme usage error:", error);
          message.textContent = error.message;
          previewButton.disabled = false;
          cancelButton.disabled = false;
          input.disabled = false;
        }
      });

      input.focus();
      input.select();
    });

    removeButton.addEventListener("click", async () => {
      removeButton.disabled = true;
      renameButton.disabled = true;

      try {
        const usageResponse = await fetch(
          `${apiBase}${usageEndpoint}?theme=${encodeURIComponent(theme)}`
        );
        const usage = await usageResponse.json();
          const affectedItems = usage[docPlural] || [];

        if (!usageResponse.ok) {
          throw new Error(usage.error || "Could not check theme usage.");
        }

        beforeMutation({kind,operation:"remove",theme,usage});
        if (!autoAssignNew && [...select.selectedOptions].some(o=>o.value===theme)) throw Error("Deselect this pending assignment before removing the global theme.");
        const confirmation = document.createElement("div");
        confirmation.className = "remove-theme-confirmation";

        const message = document.createElement("p");
        message.textContent = usage.count === 0
          ? `“${labelFor(theme)}” is not currently used by any ${docPlural}. Remove it from the collection?`
          : `“${labelFor(theme)}” is currently used by ${usage.count} ${stem}${usage.count === 1 ? "" : "s"}. Removing it from the collection will not alter those essays.`;

        if (isLocal && usage.count > 0) message.textContent = `“${labelFor(theme)}” is used by ${usage.count} ${stem}(s). Assigned themes cannot be removed. Deselecting a theme in this form changes only the new ${stem} selection.`;
        confirmation.appendChild(message);

        if (affectedItems.length) {
          const essayList = document.createElement("ul");

          for (const essay of affectedItems) {
            const item = document.createElement("li");
            item.textContent = essay.title;
            essayList.appendChild(item);
          }

          confirmation.appendChild(essayList);
        }

        const actions = document.createElement("div");
        actions.className = "remove-theme-actions";

        const cancelButton = document.createElement("button");
        cancelButton.type = "button";
        cancelButton.className = "secondary-action";
        cancelButton.textContent = "Cancel";

        const confirmButton = document.createElement("button");
        confirmButton.type = "button";
        confirmButton.className = "remove-theme-confirm-button";
        confirmButton.textContent = "Remove Theme";
        if (isLocal && usage.count > 0) confirmButton.disabled = true;

        actions.appendChild(cancelButton);
        actions.appendChild(confirmButton);
        confirmation.appendChild(actions);
        row.appendChild(confirmation);

        cancelButton.addEventListener("click", () => {
          confirmation.remove();
          removeButton.disabled = false;
          renameButton.disabled = false;
        });

        confirmButton.addEventListener("click", async () => {
          confirmButton.disabled = true;
          cancelButton.disabled = true;

          try {
            beforeMutation({kind,operation:"remove",theme,usage});
            if (!autoAssignNew && [...select.selectedOptions].some(o=>o.value===theme)) throw Error("Deselect this pending assignment before removing the global theme.");
            const response = await fetch(
              apiBase + endpoint + "/delete",
              {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                  theme,
                  confirm: true,
                  ...(isLocal ? {revision:usage.revision} : {})
                })
              }
            );

            const result = await response.json();

            if (!response.ok) {
              throw new Error(
                result.error || `Theme removal failed: ${response.status}`
              );
            }

            const option = [...select.options].find(
              item => item.value === theme
            );

            if (option) option.remove();

            const pickerButton = [...picker.querySelectorAll(".theme-choice")]
              .find(button => isLocal ? button.dataset.themeValue === theme : button.textContent === theme);

            if (pickerButton) pickerButton.remove();

            row.remove();
            manageCount.textContent = `${result.themes.length} themes`;

            const themeIndex = themes.indexOf(theme);
            if (themeIndex !== -1) themes.splice(themeIndex, 1);
            changed({removedTheme:theme});

          } catch (error) {
            console.error("Essay theme removal error:", error);
            message.textContent = error.message;
            confirmButton.remove();
            cancelButton.textContent = "Close";
            cancelButton.disabled = false;
            cancelButton.onclick = () => {
              confirmation.remove();
              removeButton.disabled = false;
              renameButton.disabled = false;
            };
          }
        });

      } catch (error) {
        console.error("Essay theme usage error:", error);
        alert(error.message);
        removeButton.disabled = false;
        renameButton.disabled = false;
      }
    });
  }

  for (const theme of themes) {
    renderManagedTheme(theme);
  }

  addThemeButton.addEventListener("click", () => {
    addThemeArea.hidden = false;
    addThemeInput.focus();
  });

  async function addTheme() {
    const theme = isLocal ? capitalize(addThemeInput.value.trim()) : addThemeInput.value.trim();

    if (!theme) {
      addThemeError.textContent = "Please enter a theme name.";
      addThemeError.hidden = false;
      addThemeInput.focus();
      return;
    }

    if(!autoAssignNew&&themes.some(v=>v.toLowerCase()===theme.toLowerCase())){addThemeError.textContent="A theme with that name already exists.";addThemeError.hidden=false;return;}
    addThemeError.textContent = "";
    addThemeError.hidden = true;

    const selectedThemes = new Set(
      [...select.selectedOptions].map(option => option.value)
    );

    confirmThemeButton.disabled = true;

    try {
      beforeMutation({kind,operation:"add",theme});
      const response = await fetch(apiBase + endpoint, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({theme})
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(
          result.error || `Theme save failed: ${response.status}`
        );
      }

      let existingOption = [...select.options]
        .find(option => isLocal ? option.value.toLowerCase() === result.theme.toLowerCase() : option.value === result.theme);

      if (!existingOption) {
        existingOption = document.createElement("option");
        existingOption.value = result.theme;
        existingOption.textContent = isLocal ? result.label : result.theme;
        select.appendChild(existingOption);

        const button = document.createElement("button");
        button.type = "button";
        button.className = "theme-choice";
        button.textContent = isLocal ? result.label : result.theme;
        if (isLocal) button.dataset.themeValue = result.theme;
        button.setAttribute("aria-pressed", "false");

        button.addEventListener("click", () => {
          existingOption.selected = !existingOption.selected;

          const selected = existingOption.selected;

          button.classList.toggle("selected", selected);
          button.setAttribute("aria-pressed", String(selected));
          notify([...select.selectedOptions].map(o=>o.value));
        });

        picker.appendChild(button);
      }

      if (!themes.includes(result.theme)) { themes.push(result.theme); themes.sort((a,b)=>a.localeCompare(b)); }
      if (isLocal) labels.set(result.theme, result.label);
      renderManagedTheme(result.theme);
      manageCount.textContent = `${manageList.children.length} themes`;

      if(autoAssignNew)selectedThemes.add(existingOption.value);

      for (const option of select.options) {
        option.selected = selectedThemes.has(option.value);
      }

      for (const button of picker.querySelectorAll(".theme-choice")) {
        const option = [...select.options].find(
          item => item.value === (isLocal ? button.dataset.themeValue : button.textContent)
        );

        const selected = option ? option.selected : false;

        button.classList.toggle("selected", selected);
        button.setAttribute("aria-pressed", String(selected));
      }

      if(autoAssignNew)notify([...select.selectedOptions].map(o=>o.value));
      changed({addedTheme:result.theme});
      addThemeInput.value = "";
      addThemeArea.hidden = true;

    } catch (error) {
      console.error("Essay theme error:", error);
      alert(error.message);

    } finally {
      confirmThemeButton.disabled = false;
    }
  }

  confirmThemeButton.addEventListener("click", addTheme);

  addThemeInput.addEventListener("input", () => {
    if (addThemeInput.value.trim()) {
      addThemeError.textContent = "";
      addThemeError.hidden = true;
    }
  });

  addThemeInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      addTheme();
    }
  });

  const eventName='lilamaya-theme-collection-changed';
  function changed(detail){document.dispatchEvent(new CustomEvent(eventName,{detail:{kind,owner:select,...detail}}));}
  let refreshGeneration=0;
  async function refreshCollection(event){
    if(event.detail.kind!==kind||event.detail.owner===select||!select.isConnected)return;
    const generation=++refreshGeneration;
    try{
      const response=await fetch(apiBase+endpoint);if(!response.ok)throw Error('Theme collection refresh failed');const data=await response.json();
      if(generation!==refreshGeneration||!select.isConnected)return;
      const previous=[...select.selectedOptions].map(o=>o.value),current=previous.map(v=>v===event.detail.oldTheme?event.detail.newTheme:v);
      themes.splice(0,themes.length,...data.themes);labels.clear();for(const item of data.themeOptions||[])labels.set(item.value,item.label);
      select.replaceChildren();picker.replaceChildren();manageList.replaceChildren();
      for(const theme of [...new Set([...themes,...current])])appendThemeChoice(document,{select,picker,theme,label:labelFor(theme),selected:current.includes(theme),onChange:notify});
      for(const theme of themes)renderManagedTheme(theme);manageCount.textContent=`${themes.length} themes`;
      if(current.some((v,i)=>v!==previous[i]))notify(current);
    }catch(error){addThemeError.textContent=error.message+' Pending document edits are retained.';addThemeError.hidden=false;}
  }
  document.addEventListener(eventName,refreshCollection);
  return {destroy(){refreshGeneration++;document.removeEventListener(eventName,refreshCollection);}};
}
