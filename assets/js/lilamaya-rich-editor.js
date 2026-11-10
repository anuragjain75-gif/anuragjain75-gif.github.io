import {Crepe} from "@milkdown/crepe";
import {
  createLilamayaSearchExtension,
  findLilamayaMatches,
  updateLilamayaSearch
} from "./lilamaya-search.js";

import {
  commandsCtx,
  editorViewCtx,
  serializerCtx
} from "@milkdown/kit/core";

import {TextSelection} from "@milkdown/kit/prose/state";

import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  wrapInHeadingCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand
} from "@milkdown/kit/preset/commonmark";

import {
  undoCommand,
  redoCommand
} from "@milkdown/kit/plugin/history";

import {
  parseHugoDocument,
  serializeHugoDocument,
  readHugoIntroduction,
  updateHugoIntroduction
} from "./lilamaya-document.js";


function createElement(tag, className, text = "") {
  const element = document.createElement(tag);

  if (className) element.className = className;
  if (text) element.textContent = text;

  return element;
}


function shortcodeInner(content, type) {
  const escapedType = type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const pattern = new RegExp(
    "^\\s*\\{\\{<\\s*" + escapedType +
    "\\s*>\\}\\}\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*" +
    "\\{\\{<\\s*\\/\\s*" + escapedType +
    "\\s*>\\}\\}[ \\t]*(?:\\r?\\n)?$"
  );

  const match = content.match(pattern);

  if (!match) {
    throw new Error(
      "Unable to read the protected " + type + " shortcode."
    );
  }

  return match[1];
}


function createShortcodeContent(type, body) {
  return (
    "{{< " + type + " >}}\n" +
    body +
    "\n{{< /" + type + " >}}\n"
  );
}


function createShortcodeSegment(kind) {
  if (kind === "introduction") {
    return {
      type: "introduction",
      content: "{{< introduction >}}\n"
    };
  }

  if (kind === "poetry" || kind === "invocation") {
    return {
      type: kind,
      content: createShortcodeContent(kind, "")
    };
  }

  throw new Error("Unknown Lilamaya shortcode.");
}


function createEditorInstance(root, markdown) {
  const crepe = new Crepe({
    root,
    defaultValue: markdown,

    features: {
      cursor: false,
      "block-edit": false,
      toolbar: false,
      "top-bar": false,
      ai: false,
      "image-block": false,
      "code-mirror": false,
      "link-tooltip": false,
      placeholder: true,
      "list-item": true,
      table: false,
      latex: false
    }
  });

  const searchExtension = createLilamayaSearchExtension();

  crepe.editor.use(searchExtension.extension);

  crepe.lilamayaSearchKey = searchExtension.key;

  return crepe;
}


function resolveImagePreviewUrls(root, imageBaseUrl, imagePreviewUrls) {
  if (!root) return;

  root.querySelectorAll('img[src^="images/"]').forEach(image => {
    const markdownPath = image.getAttribute("src");
    const previewUrl = imagePreviewUrls?.get(markdownPath);

    if (previewUrl) {
      image.setAttribute("src", previewUrl);
      return;
    }

    if (!imageBaseUrl) return;

    image.setAttribute(
      "src",
      new URL(
        markdownPath,
        new URL(imageBaseUrl, window.location.origin)
      ).href
    );
  });
}


export async function createLilamayaEditor(
  root,
  initialMarkdown = "",
  options = {}
) {
  if (!root) {
    throw new Error("Lilamaya editor root element was not found.");
  }

  const documentModel = parseHugoDocument(initialMarkdown);
  const onRequestImage = options.onRequestImage;
  const imageBaseUrl = options.imageBaseUrl || "";
  const imagePreviewUrls = new Map();

  root.replaceChildren();

  const toolbar = createElement("div", "lilamaya-toolbar");
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Lilamaya writing formatting");

  const content = createElement(
    "div",
    "lilamaya-segmented-content"
  );

  // The toolbar, search panel and content are appended together below.

  const segments = [...documentModel.segments];
  let introductionValue = readHugoIntroduction(documentModel.frontmatter);

  let editors = [];
  let activeEditor = null;
  let destroyed = false;
  let rebuilding = false;


  // Protected textareas are indexed separately from Markdown editors.
  const protectedTextareas = new WeakMap();

  // Document-wide Find interface.
  const searchPanel = createElement("div", "lilamaya-search-panel");
  searchPanel.hidden = true;
  searchPanel.setAttribute("role", "region");
  searchPanel.setAttribute("aria-label", "Find in document");

  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "lilamaya-search-input";
  searchInput.placeholder = "Find in this document";
  searchInput.setAttribute("aria-label", "Find text");

  const searchCounter = createElement(
    "span",
    "lilamaya-search-counter",
    "0 matches"
  );
  searchCounter.setAttribute("aria-live", "polite");

  function makeSearchButton(label, title) {
    const button = createElement(
      "button",
      "lilamaya-search-button",
      label
    );

    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);

    button.addEventListener("mousedown", event => {
      event.preventDefault();
    });

    return button;
  }

  const previousSearchButton = makeSearchButton("↑", "Previous match");
  const nextSearchButton = makeSearchButton("↓", "Next match");
  const closeSearchButton = makeSearchButton("×", "Close search");

  const searchTopRow = createElement(
    "div",
    "lilamaya-search-top-row"
  );

  const replaceToggleButton = makeSearchButton(
    "Replace",
    "Show or hide replacement controls"
  );
  replaceToggleButton.classList.add("lilamaya-replace-toggle");
  replaceToggleButton.setAttribute("aria-expanded", "false");

  searchTopRow.append(
    searchInput,
    previousSearchButton,
    nextSearchButton,
    searchCounter,
    replaceToggleButton,
    closeSearchButton
  );

  const replaceRow = createElement(
    "div",
    "lilamaya-replace-row"
  );
  replaceRow.hidden = true;

  const replaceInput = document.createElement("input");
  replaceInput.type = "text";
  replaceInput.className = "lilamaya-replace-input";
  replaceInput.placeholder = "Replace with…";
  replaceInput.setAttribute("aria-label", "Replacement text");

  const replaceCurrentButton = makeSearchButton(
    "Replace",
    "Replace the current match"
  );
  replaceCurrentButton.classList.add("lilamaya-replace-action");

  const replaceAllButton = makeSearchButton(
    "Replace All",
    "Replace every match in this document"
  );
  replaceAllButton.classList.add(
    "lilamaya-replace-action",
    "lilamaya-replace-all"
  );

  replaceRow.append(
    replaceInput,
    replaceCurrentButton,
    replaceAllButton
  );

  searchPanel.append(searchTopRow, replaceRow);

  replaceToggleButton.addEventListener("click", () => {
    replaceRow.hidden = !replaceRow.hidden;
    replaceToggleButton.setAttribute(
      "aria-expanded",
      String(!replaceRow.hidden)
    );

    if (!replaceRow.hidden) {
      replaceInput.focus();
    }
  });

  root.append(toolbar, searchPanel, content);

  let searchMatches = [];
  let activeSearchIndex = -1;

  function getEditorView(record) {
    let view = null;

    record.crepe.editor.action(ctx => {
      view = ctx.get(editorViewCtx);
    });

    return view;
  }

  function refreshSearch(resetActive = false) {
    if (destroyed || rebuilding) return;

    const query = searchInput.value;
    const normalizedQuery = query.toLocaleLowerCase();

    if (resetActive) {
      activeSearchIndex = -1;
    }

    searchMatches = [];

    if (normalizedQuery) {
      for (const segment of segments) {
        if (segment.type === "markdown") {
          const record = editors.find(
            item => item.segment === segment
          );

          if (!record) continue;

          const view = getEditorView(record);
          const localMatches = findLilamayaMatches(
            view.state.doc,
            query
          );

          localMatches.forEach((match, localIndex) => {
            searchMatches.push({
              type: "markdown",
              record,
              from: match.from,
              to: match.to,
              localIndex
            });
          });

        } else if (
          segment.type === "poetry" ||
          segment.type === "invocation"
        ) {
          const textarea = protectedTextareas.get(segment);

          if (!textarea) continue;

          const text = textarea.value;
          const searchableText = text.toLocaleLowerCase();
          let position = 0;

          while (position <= searchableText.length - normalizedQuery.length) {
            const foundAt = searchableText.indexOf(
              normalizedQuery,
              position
            );

            if (foundAt === -1) break;

            searchMatches.push({
              type: "protected",
              segment,
              textarea,
              from: foundAt,
              to: foundAt + normalizedQuery.length
            });

            position = foundAt + normalizedQuery.length;
          }
        }
      }
    }

    if (activeSearchIndex >= searchMatches.length) {
      activeSearchIndex = -1;
    }

    // Decorations are temporary ProseMirror decorations, not document marks.
    for (const record of editors) {
      const view = getEditorView(record);

      const activeMatch = searchMatches[activeSearchIndex];
      const localActiveIndex =
        activeMatch?.type === "markdown" &&
        activeMatch.record === record
          ? activeMatch.localIndex
          : -1;

      updateLilamayaSearch(
        view,
        record.crepe.lilamayaSearchKey,
        query,
        localActiveIndex
      );
    }

    if (!normalizedQuery) {
      searchCounter.textContent = "0 matches";
    } else if (activeSearchIndex >= 0) {
      searchCounter.textContent =
        (activeSearchIndex + 1) + " of " + searchMatches.length;
    } else {
      searchCounter.textContent =
        searchMatches.length + (
          searchMatches.length === 1 ? " match" : " matches"
        );
    }
  }

  function navigateSearch(direction) {
    refreshSearch(false);

    if (!searchMatches.length) return;

    if (activeSearchIndex === -1) {
      activeSearchIndex =
        direction > 0 ? 0 : searchMatches.length - 1;
    } else {
      activeSearchIndex =
        (activeSearchIndex + direction + searchMatches.length) %
        searchMatches.length;
    }

    refreshSearch(false);

    const match = searchMatches[activeSearchIndex];
    if (!match) return;

    if (match.type === "markdown") {
      const view = getEditorView(match.record);

      // Keep the custom search decoration as the only highlight.
      // Do not create a native browser text selection.
      const position = view.domAtPos(match.from);
      const target = position.node.nodeType === Node.ELEMENT_NODE
        ? position.node
        : position.node.parentElement;

      target?.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });

      activeEditor = match.record;

    } else {
      match.textarea.focus();
      match.textarea.setSelectionRange(match.from, match.to);
    }

    if (activeSearchIndex >= 0) {
      searchCounter.textContent =
        (activeSearchIndex + 1) + " of " + searchMatches.length;
    }
  }

  function applyReplacement(match, replacement) {
    if (!match) return false;

    if (match.type === "markdown") {
      const view = getEditorView(match.record);

      // A single ProseMirror transaction preserves surrounding content.
      // If a match crosses formatting boundaries, inserted text inherits
      // the marks at the beginning of the replaced range.
      const transaction = view.state.tr.insertText(
        replacement,
        match.from,
        match.to
      );

      view.dispatch(transaction);
      match.record.dirty = true;

    } else {
      const textarea = match.textarea;
      const currentText = textarea.value;

      textarea.value =
        currentText.slice(0, match.from) +
        replacement +
        currentText.slice(match.to);

      match.segment.content = createShortcodeContent(
        match.segment.type,
        textarea.value
      );
    }

    return true;
  }


  function replaceCurrent() {
    if (!searchInput.value || !searchMatches.length) {
      return;
    }

    if (activeSearchIndex < 0) {
      activeSearchIndex = 0;
    }

    const match = searchMatches[activeSearchIndex];
    const replacement = replaceInput.value;

    if (!applyReplacement(match, replacement)) {
      return;
    }

    // Recalculate positions after the document has changed.
    activeSearchIndex = -1;
    refreshSearch(true);
  }


  function replaceAll() {
    if (!searchInput.value || !searchMatches.length) {
      return;
    }

    const matches = [...searchMatches];
    const replacement = replaceInput.value;
    const count = matches.length;

    const confirmed = window.confirm(
      "Replace all " + count + " occurrences of \"" +
      searchInput.value + "\" with \"" + replacement +
      "\" in this document?"
    );

    if (!confirmed) return;

    // Group prose matches by editor and protected matches by segment.
    const markdownGroups = new Map();
    const protectedGroups = new Map();

    for (const match of matches) {
      if (match.type === "markdown") {
        if (!markdownGroups.has(match.record)) {
          markdownGroups.set(match.record, []);
        }
        markdownGroups.get(match.record).push(match);

      } else {
        if (!protectedGroups.has(match.segment)) {
          protectedGroups.set(match.segment, []);
        }
        protectedGroups.get(match.segment).push(match);
      }
    }

    // Work backwards so changes never invalidate earlier positions.
    for (const [record, group] of markdownGroups) {
      const view = getEditorView(record);
      let transaction = view.state.tr;

      group.sort((a, b) => b.from - a.from);

      for (const match of group) {
        transaction = transaction.insertText(
          replacement,
          match.from,
          match.to
        );
      }

      view.dispatch(transaction);
      record.dirty = true;
    }

    for (const [segment, group] of protectedGroups) {
      const textarea = protectedTextareas.get(segment);
      if (!textarea) continue;

      let text = textarea.value;

      group.sort((a, b) => b.from - a.from);

      for (const match of group) {
        text =
          text.slice(0, match.from) +
          replacement +
          text.slice(match.to);
      }

      textarea.value = text;
      segment.content = createShortcodeContent(
        segment.type,
        text
      );
    }

    // Searching again is safe: it changes decorations, not document text.
    activeSearchIndex = -1;
    refreshSearch(true);

    searchCounter.textContent =
      count + (count === 1 ? " replaced" : " replaced");
  }


  replaceCurrentButton.addEventListener("click", replaceCurrent);
  replaceAllButton.addEventListener("click", replaceAll);

  replaceInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      replaceCurrent();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearchPanel();
    }
  });


  searchInput.addEventListener("input", () => {
    refreshSearch(true);
  });

  searchInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      navigateSearch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearchPanel();
    }
  });

  previousSearchButton.addEventListener("click", () => {
    navigateSearch(-1);
  });

  nextSearchButton.addEventListener("click", () => {
    navigateSearch(1);
  });

  function closeSearchPanel() {
    searchInput.value = "";
    activeSearchIndex = -1;
    searchMatches = [];
    refreshSearch(true);
    searchPanel.hidden = true;
    replaceRow.hidden = true;
    replaceToggleButton.setAttribute("aria-expanded", "false");
    root.querySelector(".lilamaya-title-search-toggle")?.setAttribute(
      "aria-expanded", "false"
    );
  }

  closeSearchButton.addEventListener("click", closeSearchPanel);

  function openSearchPanel() {
    searchPanel.hidden = false;
    searchInput.focus();
    searchInput.select();
    refreshSearch(true);
  }


  function addSeparator() {
    toolbar.appendChild(
      createElement("span", "lilamaya-toolbar-separator")
    );
  }


  function runCommand(command, payload) {
    if (!activeEditor || destroyed || rebuilding) return;

    activeEditor.dirty = true;

    activeEditor.crepe.editor.action(ctx => {
      ctx.get(commandsCtx).call(command.key, payload);
    });
  }


  function synchronizeSegments() {
    for (const record of editors) {
      if (record.dirty) {
        record.segment.content = record.crepe.getMarkdown();
      }
    }
  }


  function splitActiveEditor(record, savedSelection = null) {
    let result = null;

    record.crepe.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const serializer = ctx.get(serializerCtx);

      const doc = view.state.doc;
      const selection = savedSelection || view.state.selection;

      const leftDocument = doc.cut(0, selection.from);
      const rightDocument = doc.cut(
        selection.to,
        doc.content.size
      );

      const leftMarkdown = serializer(leftDocument);
      const rightMarkdown = serializer(rightDocument);

      // Milkdown can serialize the empty paragraph created at
      // the split boundary as a leading <br /> in the right fragment.
      // Remove only that artificial boundary break. Preserve the
      // following newlines and every other Markdown element.
      result = {
        left: leftMarkdown,
        right: rightMarkdown.replace(/^\r?\n<br\s*\/?>(?=\r?\n)/i, "")
      };
    });

    if (!result) {
      throw new Error("Unable to split the active Markdown document.");
    }

    return result;
  }


  function renderProtectedSegment(segment) {
    const block = createElement(
      "section",
      "lilamaya-protected-block lilamaya-" + segment.type + "-block"
    );

    block.dataset.segmentType = segment.type;

    const header = createElement(
      "div",
      "lilamaya-protected-header"
    );

    const label = createElement(
      "div",
      "lilamaya-protected-label",
      segment.type.toUpperCase()
    );

    const removeButton = createElement(
      "button",
      "lilamaya-protected-remove",
      "Remove block"
    );

    removeButton.type = "button";
    removeButton.title = "Remove this shortcode block";

    removeButton.addEventListener("click", async () => {
      if (destroyed || rebuilding) return;

      const index = segments.indexOf(segment);
      if (index < 0) return;

      const confirmed = window.confirm(
        "Remove this " + segment.type +
        " block from the document?"
      );

      if (!confirmed) return;

      try {
        synchronizeSegments();

        // If this shortcode was inserted into an untouched
        // segment, restore the exact original Markdown.
        const previous = segments[index - 1];
        const next = segments[index + 1];

        const surroundingSegments = [previous, next].filter(
          item => item?.type === "markdown"
        );

        const surroundingUnchanged = surroundingSegments.every(item => {
          const record = editors.find(entry => entry.segment === item);
          return record && !record.dirty;
        });

        const canRestoreOriginal =
          typeof segment.restoreContent === "string" &&
          surroundingUnchanged;

        segments.splice(index, 1);

        if (canRestoreOriginal) {
          if (previous?.type === "markdown") {
            previous.content = segment.restoreContent;

            if (next?.type === "markdown") {
              segments.splice(index, 1);
            }
          } else if (next?.type === "markdown") {
            next.content = segment.restoreContent;
          } else {
            segments.splice(index, 0, {
              type: "markdown",
              content: segment.restoreContent
            });
          }
        } else {
          // If surrounding prose was edited, retain those edits
          // and merge the remaining Markdown segments.
          const mergedPrevious = segments[index - 1];
          const mergedNext = segments[index];

          if (
            mergedPrevious?.type === "markdown" &&
            mergedNext?.type === "markdown"
          ) {
            mergedPrevious.content += mergedNext.content;
            segments.splice(index, 1);
          }
        }

        let focusIndex = -1;

        if (segments[index]?.type === "markdown") {
          focusIndex = index;
        } else if (segments[index - 1]?.type === "markdown") {
          focusIndex = index - 1;
        }

        await rebuildSegments(focusIndex);

      } catch (error) {
        console.error("Unable to remove shortcode:", error);

        window.alert(
          "The block could not be removed. " +
          "No document has been saved."
        );
      }
    });

    header.append(label, removeButton);
    block.appendChild(header);

    if (segment.type === "introduction") {
      const textarea = document.createElement("textarea");

      textarea.className =
        "lilamaya-protected-textarea lilamaya-introduction-textarea";

      textarea.setAttribute("aria-label", "Edit essay introduction");
      textarea.setAttribute(
        "placeholder",
        "Write a short introduction to this essay..."
      );

      textarea.spellcheck = true;
      textarea.value = introductionValue;

      protectedTextareas.set(segment, textarea);

      textarea.addEventListener("input", () => {
        introductionValue = textarea.value;

        if (searchInput.value) refreshSearch(false);

        textarea.style.height = "auto";
        textarea.style.height =
          Math.max(100, textarea.scrollHeight) + "px";
      });

      block.appendChild(textarea);

      requestAnimationFrame(() => {
        textarea.style.height = "auto";
        textarea.style.height =
          Math.max(100, textarea.scrollHeight) + "px";
      });

      return block;
    }

    const textarea = document.createElement("textarea");

    textarea.className =
      "lilamaya-protected-textarea lilamaya-" +
      segment.type + "-textarea";

    textarea.setAttribute(
      "aria-label",
      "Edit " + segment.type + " content"
    );

    textarea.spellcheck = true;
    textarea.value = shortcodeInner(
      segment.content,
      segment.type
    );
    protectedTextareas.set(segment, textarea);

    textarea.addEventListener("input", () => {
      segment.content = createShortcodeContent(
        segment.type,
        textarea.value
      );
      if (searchInput.value) refreshSearch(false);

      textarea.style.height = "auto";
      textarea.style.height =
        Math.max(100, textarea.scrollHeight) + "px";
    });

    block.appendChild(textarea);

    requestAnimationFrame(() => {
      textarea.style.height = "auto";
      textarea.style.height =
        Math.max(100, textarea.scrollHeight) + "px";
    });

    if (segment.type === "invocation") {
      block.appendChild(
        createElement(
          "div",
          "lilamaya-invocation-separator",
          "●"
        )
      );
    }

    return block;
  }


  async function rebuildSegments(focusIndex = -1) {
    if (destroyed) return;

    rebuilding = true;
    activeEditor = null;

    const oldEditors = editors;
    editors = [];

    for (const record of oldEditors) {
      await record.crepe.destroy();
    }

    content.replaceChildren();

    try {
      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];

        if (segment.type !== "markdown") {
          content.appendChild(
            renderProtectedSegment(segment)
          );

          continue;
        }

        if (segment.content.trim() === "" && index !== focusIndex) {
          continue;
        }

        const section = createElement(
          "section",
          "lilamaya-editable-segment"
        );

        const editorRoot = createElement(
          "div",
          "lilamaya-editor-area"
        );

        section.appendChild(editorRoot);
        content.appendChild(section);

        const record = {
          segment,
          dirty: false,
          crepe: createEditorInstance(
            editorRoot,
            segment.content
          ),
          root: editorRoot,
          segmentIndex: index
        };

        await record.crepe.create();

        resolveImagePreviewUrls(editorRoot, imageBaseUrl, imagePreviewUrls);

        editorRoot.addEventListener("focusin", () => {
          if (!rebuilding && !destroyed) {
            activeEditor = record;
          }
        });

        editorRoot.addEventListener("input", () => {
          record.dirty = true;
          if (searchInput.value) refreshSearch(false);
        });

        editors.push(record);

        if (!activeEditor) activeEditor = record;
      }

      rebuilding = false;
      if (searchInput.value) refreshSearch(false);

      if (focusIndex >= 0) {
        const target = editors.find(
          record => record.segmentIndex === focusIndex
        );

        if (target) {
          activeEditor = target;

          target.crepe.editor.action(ctx => {
            const view = ctx.get(editorViewCtx);

            const position = Math.min(
              1,
              view.state.doc.content.size
            );

            view.dispatch(
              view.state.tr.setSelection(
                TextSelection.create(
                  view.state.doc,
                  position
                )
              )
            );

            view.focus();
          });
        }
      }

    } catch (error) {
      rebuilding = false;
      throw error;
    }
  }


  async function insertShortcode(kind) {
    if (!activeEditor || destroyed || rebuilding) return;

    const record = activeEditor;
    const segmentIndex = segments.indexOf(record.segment);

    if (segmentIndex < 0) {
      throw new Error("Active editor segment was not found.");
    }

    synchronizeSegments();

    // Keep an exact snapshot so removing an untouched shortcode
    // can restore the original Markdown without serialization loss.
    const originalContent = record.segment.content;

    const split = splitActiveEditor(record);
    const shortcode = createShortcodeSegment(kind);

    shortcode.restoreContent = originalContent;

    const replacement = [];

    if (split.left) {
      replacement.push({
        type: "markdown",
        content: split.left
      });
    }

    replacement.push(shortcode);

    if (split.right) {
      replacement.push({
        type: "markdown",
        content: split.right
      });
    }

    segments.splice(segmentIndex, 1, ...replacement);

    const rightIndex =
      segmentIndex +
      (split.left ? 1 : 0) +
      1;

    await rebuildSegments(
      split.right ? rightIndex : -1
    );
  }


  function createImageInsertionCallback() {
    if (!activeEditor || destroyed || rebuilding) {
      throw new Error("No active editor is available for image insertion.");
    }

    const record = activeEditor;
    let savedSelection = null;

    record.crepe.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const selection = view.state.selection;

      savedSelection = {
        from: selection.from,
        to: selection.to
      };
    });

    if (!savedSelection) {
      throw new Error("Could not capture the image insertion position.");
    }

    // The callback retains the original editor and cursor position,
    // even while the native file picker has focus.
    return (markdown, previewUrl) =>
      insertImageAtCursor(
        markdown,
        record,
        savedSelection,
        previewUrl
      );
  }


  async function insertImageAtCursor(
    markdown,
    record,
    savedSelection,
    previewUrl
  ) {

    if (
      !record ||
      !savedSelection ||
      destroyed ||
      rebuilding ||
      typeof markdown !== "string" ||
      !/^!\[[^\]]*\]\(images\/[A-Za-z0-9._-]+\)$/.test(markdown) ||
      typeof previewUrl !== "string" ||
      !previewUrl.startsWith("blob:")
    ) {
      throw new Error("Invalid image insertion request.");
    }

    const imageMatch = markdown.match(
      /\]\((images\/[A-Za-z0-9._-]+)\)$/
    );

    if (!imageMatch) {
      throw new Error("Could not identify the inserted image path.");
    }

    const imagePath = imageMatch[1];
    const segmentIndex = segments.indexOf(record.segment);


    if (segmentIndex < 0) {
      throw new Error("Active editor segment was not found.");
    }

    synchronizeSegments();

    const split = splitActiveEditor(record, savedSelection);

    const replacement = [];

    if (split.left) {
      replacement.push({
        type: "markdown",
        content: split.left
      });
    }

    replacement.push({
      type: "markdown",
      content: (split.left ? "\n\n" : "") + markdown + "\n\n"
    });

    replacement.push({
      type: "markdown",
      content: split.right || ""
    });

    segments.splice(segmentIndex, 1, ...replacement);

    const rightIndex =
      segmentIndex +
      (split.left ? 1 : 0) +
      2;

    imagePreviewUrls.set(imagePath, previewUrl);


    try {
      await rebuildSegments(rightIndex);
    } catch (error) {
      imagePreviewUrls.delete(imagePath);
      throw error;
    }
  }


  function createButton(label, title, command, payload) {
    const button = createElement(
      "button",
      "lilamaya-toolbar-button",
      label
    );

    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);

    button.addEventListener("mousedown", event => {
      event.preventDefault();
    });

    button.addEventListener("click", () => {
      runCommand(command, payload);
    });

    toolbar.appendChild(button);
    return button;
  }


  // Undo and redo.

  createButton("↶", "Undo", undoCommand);
  createButton("↷", "Redo", redoCommand);

  addSeparator();


  // Text formatting.

  createButton("B", "Bold", toggleStrongCommand);
  createButton("I", "Italic", toggleEmphasisCommand);

  addSeparator();


  // Paragraph and heading selector.

  const headingSelect = document.createElement("select");
  headingSelect.className = "lilamaya-toolbar-select";
  headingSelect.setAttribute("aria-label", "Paragraph style");

  const headingOptions = [
    ["paragraph", "Paragraph"],
    ["1", "Heading 1"],
    ["2", "Heading 2"],
    ["3", "Heading 3"],
    ["4", "Heading 4"],
    ["5", "Heading 5"],
    ["6", "Heading 6"]
  ];

  for (const [value, label] of headingOptions) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    headingSelect.appendChild(option);
  }

  headingSelect.addEventListener("change", () => {
    if (!activeEditor || destroyed || rebuilding) return;

    activeEditor.dirty = true;

    activeEditor.crepe.editor.action(ctx => {
      const commands = ctx.get(commandsCtx);

      if (headingSelect.value === "paragraph") {
        commands.call(turnIntoTextCommand.key);
      } else {
        commands.call(
          wrapInHeadingCommand.key,
          Number(headingSelect.value)
        );
      }
    });
  });

  toolbar.appendChild(headingSelect);

  addSeparator();


  // Blockquote.

  createButton(
    "❝",
    "Blockquote",
    wrapInBlockquoteCommand
  );

  addSeparator();


  // Inline image insertion.

  if (typeof onRequestImage === "function") {
    const imageButton = createElement(
      "button",
      "lilamaya-toolbar-button",
      "▧"
    );

    imageButton.type = "button";
    imageButton.title = "Insert image";
    imageButton.setAttribute("aria-label", "Insert image");

    imageButton.addEventListener("mousedown", event => {
      event.preventDefault();
    });

    imageButton.addEventListener("click", () => {
      try {
        const insertAtSavedPosition =
          createImageInsertionCallback();

        onRequestImage(insertAtSavedPosition);
      } catch (error) {
        console.error("Unable to prepare image insertion:", error);
        window.alert(error.message || "Could not prepare image insertion.");
      }
    });

    toolbar.appendChild(imageButton);
    addSeparator();
  }


  // Hugo shortcode dropdown.

  const shortcodeSelect = document.createElement("select");

  shortcodeSelect.className =
    "lilamaya-toolbar-select lilamaya-shortcode-select";

  shortcodeSelect.setAttribute(
    "aria-label",
    "Insert Hugo shortcode"
  );

  const shortcodeOptions = [
    ["", "Shortcodes"],
    ["introduction", "Introduction"],
    ["poetry", "Poetry"],
    ["invocation", "Invocation"]
  ];

  for (const [value, label] of shortcodeOptions) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    shortcodeSelect.appendChild(option);
  }

  shortcodeSelect.addEventListener("change", async () => {
    const kind = shortcodeSelect.value;
    if (!kind) return;

    shortcodeSelect.disabled = true;

    try {
      await insertShortcode(kind);
    } catch (error) {
      console.error("Shortcode insertion failed:", error);

      window.alert(
        "The shortcode could not be inserted. " +
        "No document has been saved."
      );
    } finally {
      shortcodeSelect.value = "";
      shortcodeSelect.disabled = false;
    }
  });

  toolbar.appendChild(shortcodeSelect);




  // Initial document rendering.

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];

    if (segment.type !== "markdown") {
      content.appendChild(
        renderProtectedSegment(segment)
      );

      continue;
    }

    if (segment.content.trim() === "") {
      continue;
    }

    const section = createElement(
      "section",
      "lilamaya-editable-segment"
    );

    const editorRoot = createElement(
      "div",
      "lilamaya-editor-area"
    );

    section.appendChild(editorRoot);
    content.appendChild(section);

    const record = {
      segment,
      dirty: false,
      crepe: createEditorInstance(
        editorRoot,
        segment.content
      ),
      root: editorRoot,
      segmentIndex: index
    };

    await record.crepe.create();

    resolveImagePreviewUrls(editorRoot, imageBaseUrl, imagePreviewUrls);

    editorRoot.addEventListener("focusin", () => {
      if (!rebuilding && !destroyed) {
        activeEditor = record;
      }
    });

    editorRoot.addEventListener("input", () => {
      record.dirty = true;
      if (searchInput.value) refreshSearch(false);
    });

    editors.push(record);

    if (!activeEditor) activeEditor = record;
  }


  return {

    getMarkdown() {
      if (destroyed) {
        throw new Error("The Lilamaya editor has been destroyed.");
      }

      synchronizeSegments();

      return serializeHugoDocument({
        frontmatter: updateHugoIntroduction(
          documentModel.frontmatter,
          introductionValue
        ),
        segments
      });
    },


    async destroy() {
      if (destroyed) return;

      destroyed = true;

      for (const record of editors) {
        await record.crepe.destroy();
      }

      for (const previewUrl of imagePreviewUrls.values()) {
        URL.revokeObjectURL(previewUrl);
      }
      imagePreviewUrls.clear();

      editors.length = 0;
      activeEditor = null;

      root.replaceChildren();
    },


    openSearch() {
      if (!destroyed) openSearchPanel();
    },

    closeSearch() {
      if (!destroyed) closeSearchPanel();
    },

    attachSearchPanel(container) {
      if (!destroyed && container) container.appendChild(searchPanel);
    },

    get editor() {
      return activeEditor?.crepe.editor || null;
    }

  };
}
