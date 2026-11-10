import {createLilamayaEditor} from "./lilamaya-rich-editor.js";

const defaultDocumentPath = "content/essays/the-art-of-becoming-whole/index.md";
let documentPath = defaultDocumentPath;
let documentSha = null;
let richEditor = null;
let savedContent = null;
let savedConnections = "[]";
let newEssayMode = false;
let newEntryMode = false;
let availableDocuments = [];

function showLibraryScreen() {
  newEssayMode = false;
  newEntryMode = false;

  document.querySelector("#new-essay-form").hidden = true;
  document.querySelector("#new-entry-form").hidden = true;
  const documentSelector = document.querySelector("#document-selector");
  documentSelector.hidden = false;

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
}

const apiBase = "http://localhost:1314";

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
    const essayMatch = documentPath.match(
      /^content\/essays\/([a-z0-9-]+)\/index\.md$/i
    );

    if (!essayMatch) {
      throw new Error("Inline images can only be inserted into essay documents.");
    }

    const imagePath =
      `content/essays/${essayMatch[1]}/images/${filename}`;

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
        local: documentSha === "LOCAL"
      })
    });

    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Image upload failed.");
    }

    const markdown =
      `![${altText.replace(/[\[\]\\]/g, "")}](images/${filename})`;

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

async function loadDocument(path) {
  const data = await fetchDocument(path);

  documentPath = data.path;
  documentSha = data.sha;
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
      onRequestImage: handleImageInsertion,
      imageBaseUrl: (() => {
        const match = documentPath.match(
          /^content\/essays\/([a-z0-9-]+)\/index\.md$/i
        );

        return match
          ? `/essays/${match[1]}/`
          : "";
      })()
    }
  );

  // Display the actual title of the currently loaded document.
  const documentTitle =
    data.title ||
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
  titleMeta.textContent = sectionForPath(documentPath).toUpperCase();

  titlePanel.append(titleRow, titleMeta);
  richEditor.attachSearchPanel(titlePanel);
  editorRoot.insertBefore(titlePanel, editorRoot.firstChild);

  renderDocumentConnections(data.connections || []);
  savedContent = data.content;
  savedConnections = JSON.stringify(collectDocumentConnections());
  document.querySelector("#save-status").textContent = "";
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

    for (const item of items) {
      const option = document.createElement("option");
      option.value = item.path;
      option.textContent = item.title;
      option.selected = item.path === documentPath;
      select.appendChild(option);
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

async function loadEssayThemes() {
  const response = await fetch(`${apiBase}/api/essay-themes`);

  if (!response.ok) {
    throw new Error(`Essay themes failed: ${response.status}`);
  }

  const data = await response.json();
  const themes = data.themes || [];
  const select = document.querySelector("#new-essay-themes");

  select.innerHTML = "";
  select.classList.add("theme-select-hidden");

  const picker = document.createElement("div");
  picker.className = "theme-picker";

  for (const theme of themes) {
    const option = document.createElement("option");
    option.value = theme;
    option.textContent = theme;
    select.appendChild(option);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "theme-choice";
    button.textContent = theme;
    button.setAttribute("aria-pressed", "false");

    button.addEventListener("click", () => {
      option.selected = !option.selected;

      const selected = option.selected;

      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });

    picker.appendChild(button);
  }

  select.parentNode.insertBefore(picker, select);

  const addThemeButton = document.querySelector("#add-essay-theme");

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
    "Rename themes across the collection and essays, or remove them from the collection.";

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
    name.textContent = theme;

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
      input.value = theme;
      input.maxLength = 100;
      input.setAttribute("aria-label", `New name for ${theme}`);

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
        const newTheme = input.value.trim();

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

        if (newTheme === theme) {
          message.textContent = "The new name is identical to the current name.";
          input.focus();
          return;
        }

        if (themes.includes(newTheme)) {
          message.textContent = "A theme with that name already exists.";
          input.focus();
          return;
        }

        previewButton.disabled = true;
        cancelButton.disabled = true;
        input.disabled = true;
        message.textContent = "Checking which essays use this theme…";

        try {
          const usageResponse = await fetch(
            `${apiBase}/api/essay-theme-usage?theme=${encodeURIComponent(theme)}`
          );
          const usage = await usageResponse.json();

          if (!usageResponse.ok) {
            throw new Error(usage.error || "Could not check theme usage.");
          }

          message.textContent = usage.count === 0
            ? `Rename “${theme}” to “${newTheme}”? No essays currently use this theme.`
            : `Rename “${theme}” to “${newTheme}”? This will update ${usage.count} essay${usage.count === 1 ? "" : "s"} as well as the theme collection.`;

          if (usage.essays.length) {
            const essayList = document.createElement("ul");

            for (const essay of usage.essays) {
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

          confirmButton.addEventListener("click", async () => {
            confirmButton.disabled = true;
            finalCancelButton.disabled = true;
            message.textContent = "Updating the theme collection and essays…";

            try {
              const response = await fetch(
                apiBase + "/api/essay-themes/rename",
                {
                  method: "POST",
                  headers: {"Content-Type": "application/json"},
                  body: JSON.stringify({
                    oldTheme: theme,
                    newTheme,
                    confirm: true
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
                option.textContent = newTheme;
                option.selected = selectedThemes.has(theme);
              }

              const pickerButton = [...picker.querySelectorAll(".theme-choice")]
                .find(button => button.textContent === theme);

              if (pickerButton) {
                pickerButton.textContent = newTheme;
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
              name.textContent = newTheme;

              manageList.removeChild(row);
              renderManagedTheme(newTheme);
              manageCount.textContent = `${result.themes.length} themes`;

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
          `${apiBase}/api/essay-theme-usage?theme=${encodeURIComponent(theme)}`
        );
        const usage = await usageResponse.json();

        if (!usageResponse.ok) {
          throw new Error(usage.error || "Could not check theme usage.");
        }

        const confirmation = document.createElement("div");
        confirmation.className = "remove-theme-confirmation";

        const message = document.createElement("p");
        message.textContent = usage.count === 0
          ? `“${theme}” is not currently used by any essays. Remove it from the collection?`
          : `“${theme}” is currently used by ${usage.count} essay${usage.count === 1 ? "" : "s"}. Removing it from the collection will not alter those essays.`;

        confirmation.appendChild(message);

        if (usage.essays.length) {
          const essayList = document.createElement("ul");

          for (const essay of usage.essays) {
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
            const response = await fetch(
              apiBase + "/api/essay-themes/delete",
              {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                  theme,
                  confirm: true
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
              .find(button => button.textContent === theme);

            if (pickerButton) pickerButton.remove();

            row.remove();
            manageCount.textContent = `${result.themes.length} themes`;

            const themeIndex = themes.indexOf(theme);
            if (themeIndex !== -1) themes.splice(themeIndex, 1);

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
    const theme = addThemeInput.value.trim();

    if (!theme) {
      addThemeError.textContent = "Please enter a theme name.";
      addThemeError.hidden = false;
      addThemeInput.focus();
      return;
    }

    addThemeError.textContent = "";
    addThemeError.hidden = true;

    const selectedThemes = new Set(
      [...select.selectedOptions].map(option => option.value)
    );

    confirmThemeButton.disabled = true;

    try {
      const response = await fetch(apiBase + "/api/essay-themes", {
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
        .find(option => option.value === result.theme);

      if (!existingOption) {
        existingOption = document.createElement("option");
        existingOption.value = result.theme;
        existingOption.textContent = result.theme;
        select.appendChild(existingOption);

        const button = document.createElement("button");
        button.type = "button";
        button.className = "theme-choice";
        button.textContent = result.theme;
        button.setAttribute("aria-pressed", "false");

        button.addEventListener("click", () => {
          existingOption.selected = !existingOption.selected;

          const selected = existingOption.selected;

          button.classList.toggle("selected", selected);
          button.setAttribute("aria-pressed", String(selected));
        });

        picker.appendChild(button);
      }

      renderManagedTheme(result.theme);
      manageCount.textContent = `${manageList.children.length} themes`;

      selectedThemes.add(result.theme);

      for (const option of select.options) {
        option.selected = selectedThemes.has(option.value);
      }

      for (const button of picker.querySelectorAll(".theme-choice")) {
        const option = [...select.options].find(
          item => item.value === button.textContent
        );

        const selected = option ? option.selected : false;

        button.classList.toggle("selected", selected);
        button.setAttribute("aria-pressed", String(selected));
      }

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

async function saveDocument() {
  const markdownText = richEditor.getMarkdown();

  const savePayload = {
    path: documentPath,
    content: markdownText,
    sha: documentSha,
    connections: collectDocumentConnections()
  };

  console.log("Lilamaya Save:", savePayload);

  const saveStatus = document.querySelector("#save-status");

  if (updateDuplicateWarnings("#document-connection-list")) {
    saveStatus.textContent = "Resolve duplicate connections before saving.";
    return;
  }

  saveStatus.textContent = "Saving…";

  try {
    const response = await fetch(apiBase + "/api/save", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(savePayload)
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || `Save failed: ${response.status}`);
    }

    documentSha = result.sha;
    savedContent = markdownText;
    savedConnections = JSON.stringify(savePayload.connections);
    saveStatus.textContent = "Saved";
  } catch (error) {
    console.error("Lilamaya Save Error:", error);
    saveStatus.textContent = "Save failed";
  }

  setTimeout(() => {
    saveStatus.textContent = "";
  }, 2000);
}

async function beginNewEssay() {
  const newEssayForm = document.querySelector("#new-essay-form");
  const documentSelector = document.querySelector("#document-selector");
  const editorActions = document.querySelector(".editor-actions");
  const codeMirrorEditor = document.querySelector("#codemirror-editor");

  const titleInput = document.querySelector("#new-essay-title");
  const introductionInput = document.querySelector("#new-essay-introduction");
  const themesSelect = document.querySelector("#new-essay-themes");
  const imageInput = document.querySelector("#new-essay-image");
  const beginButton = document.querySelector("#begin-new-essay");

  const title = titleInput.value.trim();
  const introduction = introductionInput.value.trim();
  const themes = [...themesSelect.selectedOptions].map(option => option.value);
  const imageFile = imageInput.files[0] || null;

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
    titleError.textContent = "Please enter a title for this essay.";
    titleError.hidden = false;
    titleInput.focus();
    return;
  }

  beginButton.disabled = true;
  beginButton.textContent = "Creating…";

  try {
    const response = await fetch(apiBase + "/api/new-essay", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title,
        introduction,
        themes,
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
          content: base64
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

    newEssayMode = false;
    newEssayForm.hidden = true;
    documentSelector.hidden = false;
    editorActions.hidden = false;
    codeMirrorEditor.hidden = false;

    await loadDocumentList();
    await loadDocument(result.path);
    showEditorScreen();

  } catch (error) {
    console.error("New Essay error:", error);
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
  if (!richEditor || savedContent === null) return false;

  const contentChanged =
    richEditor.getMarkdown() !== savedContent;

  const connectionsChanged =
    JSON.stringify(collectDocumentConnections()) !== savedConnections;

  return contentChanged || connectionsChanged;
}

function confirmDiscardUnsavedChanges() {
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

    document.querySelector("#save-status").textContent =
      result.local ? "Local test entry created — draft" : "Entry created — draft";

  } catch (error) {
    console.error("New Entry Error:", error);
    status.textContent = error.message;

  } finally {
    button.disabled = false;
    button.textContent = "Create Entry";
  }
}

async function loadEditor() {
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

  if (newEssayButton) {
    newEssayButton.addEventListener("click", () => {
      if (!confirmDiscardUnsavedChanges()) return;

      essayTitleError.textContent = "";
      essayTitleError.hidden = true;

      newEssayMode = true;
      newEntryMode = false;
      newEntryForm.hidden = true;
      newEssayForm.hidden = false;
      document.querySelector("#document-connections").hidden = true;
      documentSelector.hidden = true;
      editorActions.hidden = true;
      codeMirrorEditor.hidden = true;

      document.querySelector("#new-essay-title").focus();

      window.scrollTo({
        top: newEssayForm.offsetTop - 30,
        behavior: "smooth"
      });
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
    await loadEssayThemes();
    showEditorScreen();
  } catch (error) {
    console.error("Lilamaya Editor Error:", error);
    alert(error.message);
  }
}

loadEditor();
