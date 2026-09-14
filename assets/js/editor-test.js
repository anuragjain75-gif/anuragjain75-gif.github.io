import {EditorState} from "@codemirror/state";
import {EditorView, keymap, lineNumbers} from "@codemirror/view";
import {defaultKeymap, history, historyKeymap} from "@codemirror/commands";
import {markdown} from "@codemirror/lang-markdown";

let documentPath = "content/essays/the-art-of-becoming-whole/index.md";
let documentSha = null;
let view = null;
let newEssayMode = false;

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

async function loadDocument(path) {
  const data = await fetchDocument(path);

  documentPath = data.path;
  documentSha = data.sha;

  if (!view) {
    const state = EditorState.create({
      doc: data.content,
      extensions: [
        lineNumbers(),
        history(),
        markdown(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap
        ]),
        EditorView.lineWrapping
      ]
    });

    view = new EditorView({
      state,
      parent: document.querySelector("#codemirror-editor")
    });
  } else {
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: data.content
      },
      selection: {
        anchor: 0
      }
    });
  }

  document.querySelector("#save-status").textContent = "";
}

function sectionForPath(path) {
  if (path.startsWith("content/essays/")) return "Essays";
  if (path.startsWith("content/fragments/")) return "Fragments";
  if (path.startsWith("content/paintings/")) return "Paintings";
  return "Other";
}

function renderDocumentSelector(documents) {
  const selector = document.querySelector("#document-selector");

  if (newEssayMode) {
    selector.hidden = true;
    return;
  }

  selector.hidden = false;

  const groups = {
    Essays: [],
    Fragments: [],
    Paintings: []
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

    for (const item of items) {
      const option = document.createElement("option");
      option.value = item.path;
      option.textContent = item.title;

      if (item.path === documentPath) {
        option.selected = true;
      }

      select.appendChild(option);
    }

    select.addEventListener("change", async () => {
      try {
        await loadDocument(select.value);

        for (const otherSelect of document.querySelectorAll(
          ".document-selector-select"
        )) {
          if (otherSelect !== select) {
            const section = otherSelect.getAttribute("aria-label");
            const itemsForSection = groups[section];

            if (itemsForSection && itemsForSection.length) {
              const current = itemsForSection.find(
                item => item.path === documentPath
              );

              otherSelect.value = current ? current.path : "";
            }
          }
        }
      } catch (error) {
        console.error("Lilamaya Document Load Error:", error);
      }
    });

    wrapper.appendChild(heading);
    wrapper.appendChild(select);
    selector.appendChild(wrapper);
  }
}

async function loadEssayThemes() {
  const response = await fetch("/editor-data/essay-themes.json");

  if (!response.ok) {
    throw new Error(`Essay themes failed: ${response.status}`);
  }

  const themes = await response.json();
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

  addThemeArea.appendChild(addThemeInput);
  addThemeArea.appendChild(confirmThemeButton);

  addThemeButton.insertAdjacentElement("afterend", addThemeArea);

  addThemeButton.addEventListener("click", () => {
    addThemeArea.hidden = false;
    addThemeInput.focus();
  });

  async function addTheme() {
    const theme = addThemeInput.value.trim();

    if (!theme) {
      addThemeInput.focus();
      return;
    }

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

      existingOption.selected = true;

      const themeButton = [...picker.querySelectorAll(".theme-choice")]
        .find(button => button.textContent === result.theme);

      if (themeButton) {
        themeButton.classList.add("selected");
        themeButton.setAttribute("aria-pressed", "true");
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

  renderDocumentSelector(data.documents);
}

async function saveDocument() {
  const markdownText = view.state.doc.toString();

  const savePayload = {
    path: documentPath,
    content: markdownText,
    sha: documentSha
  };

  console.log("Lilamaya Save:", savePayload);

  const saveStatus = document.querySelector("#save-status");
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
    saveStatus.textContent = "Saved";
  } catch (error) {
    console.error("Lilamaya Save Error:", error);
    saveStatus.textContent = "Save failed";
  }

  setTimeout(() => {
    saveStatus.textContent = "";
  }, 2000);
}

async function loadEditor() {
  const newEssayForm = document.querySelector("#new-essay-form");
  const newEssayButton = [...document.querySelectorAll(
    ".author-bar button"
  )].find(button => button.textContent.trim() === "New Essay");

  const cancelNewEssay = document.querySelector("#cancel-new-essay");

  const documentSelector = document.querySelector("#document-selector");
  const editorActions = document.querySelector(".editor-actions");
  const codeMirrorEditor = document.querySelector("#codemirror-editor");

  if (newEssayButton) {
    newEssayButton.addEventListener("click", () => {
      newEssayMode = true;
      newEssayForm.hidden = false;
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

  cancelNewEssay.addEventListener("click", () => {
    newEssayMode = false;
    newEssayForm.hidden = true;
    documentSelector.hidden = false;
    editorActions.hidden = false;
    codeMirrorEditor.hidden = false;
  });

  document
    .querySelector("#save-editor")
    .addEventListener("click", saveDocument);

  try {
    await loadDocument(documentPath);
    await loadEssayThemes();
    await loadDocumentList();

    const firstButton = document.querySelector(
      ".document-selector-button"
    );

    if (firstButton) {
      const buttons = [
        ...document.querySelectorAll(".document-selector-button")
      ];

      const matchingButton = buttons.find(
        button =>
          button.textContent === "The Art of Becoming Whole"
      );

      (matchingButton || firstButton).classList.add("active");
    }
  } catch (error) {
    console.error("Lilamaya Editor Error:", error);
  }
}

loadEditor();
