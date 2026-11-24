import {Crepe} from "@milkdown/crepe";
import {
  createLilamayaSearchExtension,
  findLilamayaMatches,
  updateLilamayaSearch
} from "./lilamaya-search.js";

import {
  commandsCtx,
  editorViewCtx,
  parserCtx,
  remarkCtx,
  schemaCtx,
  serializerCtx
} from "@milkdown/kit/core";

import {SerializerState} from "@milkdown/kit/transformer";

import {trailingConfig} from "@milkdown/kit/plugin/trailing";

import {Plugin, TextSelection} from "@milkdown/kit/prose/state";
import {$prose, $remark} from "@milkdown/kit/utils";

import {
  headingIdGenerator,
  toggleStrongCommand,
  toggleEmphasisCommand,
  wrapInHeadingCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand
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

import {
  applySourceReplacements,
  planNodeReconciliation,
  buildSeparatorAwareReplacements
} from "./lilamaya-source-sync.js";


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


function createShortcodeContent(type, body, eol = "\n") {
  return (
    "{{< " + type + " >}}" + eol +
    body +
    eol + "{{< /" + type + " >}}" + eol
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


function createTransactionDiagnosticExtension() {
  return $prose(() => new Plugin({
    state: {
      init() {
        return null;
      },

      apply(transaction, value, oldState, newState) {
        if (!transaction.docChanged) {
          return value;
        }

        const steps = transaction.steps.map((step, index) => ({
          index,
          type: step.constructor.name,
          data: step.toJSON()
        }));

        console.groupCollapsed(
          "[Lilamaya] Document transaction — " +
          steps.length + " step(s)"
        );

        function inspectTopLevelNodes(doc) {
          const nodes = [];

          doc.forEach((node, offset) => {
            nodes.push({
              type: node.type.name,
              from: offset,
              to: offset + node.nodeSize,
              nodeSize: node.nodeSize,
              text: node.textContent,
              structure: node.toJSON()
            });
          });

          return nodes;
        }

        console.log("Transaction steps:", steps);

        function firstBlockquote(doc) {
          let result = null;

          doc.forEach(node => {
            if (!result && node.type.name === "blockquote") {
              result = node.toJSON();
            }
          });

          return result;
        }

        console.log(
          "FIRST BLOCKQUOTE BEFORE:",
          JSON.stringify(firstBlockquote(oldState.doc), null, 2)
        );

        console.log(
          "FIRST BLOCKQUOTE AFTER:",
          JSON.stringify(firstBlockquote(newState.doc), null, 2)
        );

        console.groupEnd();

        return value;
      }
    }
  }));
}



function createSourceMapDiagnostic(sourceMap) {
  return $remark(
    "lilamayaSourceMapDiagnostic",
    () => () => (tree, file) => {
      const blockTypes = new Set([
        "heading",
        "paragraph",
        "blockquote",
        "list",
        "listItem",
        "code",
        "thematicBreak",
        "table",
        "html"
      ]);

      const blocks = [];
      const inlineNodes = [];
      let currentBlock = null;

      function visit(node, depth = 0, inlineAncestors = []) {
        if (!node || typeof node !== "object") return;

        const start = node.position?.start?.offset ?? null;
        const end = node.position?.end?.offset ?? null;

        if (blockTypes.has(node.type)) {
          const block = {
            type: node.type,
            depth,
            start,
            end,
            source: (
              start != null &&
              end != null
            )
              ? String(file.value ?? "").slice(start, end).slice(0, 220)
              : null
          };

          blocks.push(block);

          const previousBlock = currentBlock;
          currentBlock = block;

          if (Array.isArray(node.children)) {
            node.children.forEach(child =>
              visit(child, depth + 1, [])
            );
          }

          currentBlock = previousBlock;
          return;
        }

        if (currentBlock && start != null && end != null) {
          inlineNodes.push({
            type: node.type,
            parentBlock: currentBlock.type,
            parentStart: currentBlock.start,
            parentInline: inlineAncestors,
            depth,
            start,
            end,
            value: typeof node.value === "string"
              ? node.value
              : null,
            source: String(file.value ?? "").slice(start, end).slice(0, 160)
          });
        }

        const nextAncestors = (
          node.type !== "text" &&
          start != null &&
          end != null
        )
          ? [
              ...inlineAncestors,
              { type: node.type, start, end }
            ]
          : inlineAncestors;

        if (Array.isArray(node.children)) {
          node.children.forEach(child =>
            visit(child, depth + 1, nextAncestors)
          );
        }
      }

      visit(tree);

      sourceMap.push({
        sourceLength: String(file.value ?? "").length,
        blocks,
        inlineNodes
      });
    }
  );
}

function isGeneratedTrailingCursor(nodes, generated, originalNodes = []) {
  const last = nodes.at(-1);
  return !!last && last.type.name === "paragraph" && last.content.size === 0 &&
    !!generated?.has(last) && !originalNodes.includes(last) &&
    nodes.filter(node => node === last).length === 1;
}

function sourceBackedBaselineDocument(document, sourceMap, generatedTrailingParagraphs) {
  const trailing = document.lastChild;
  const nodes = []; document.forEach(node => nodes.push(node));
  if (!Array.isArray(sourceMap?.blocks) ||
      sourceMap.blocks.filter(block => block.depth === 1).length !== document.childCount - 1 ||
      !isGeneratedTrailingCursor(nodes, generatedTrailingParagraphs)) return document;

  // Project only a proven cursor node out of the validation baseline. Keep all
  // source-backed nodes, attributes and identities; never alter the live editor.
  return document.copy(document.content.cut(0, document.content.size - trailing.nodeSize));
}

function captureOriginalSourceMap(sourceMaps, originalSource, originalDocument) {
  if (
    !Array.isArray(sourceMaps) ||
    sourceMaps.length === 0 ||
    typeof originalSource !== "string" ||
    !originalDocument
  ) {
    console.error(
      "Unable to capture original source map: initial parser data is missing."
    );
    return null;
  }

  // The first entry belongs to the initial Markdown parse.
  const initialMap = sourceMaps[0];

  if (
    !initialMap ||
    initialMap.sourceLength !== originalSource.length ||
    !Array.isArray(initialMap.blocks)
  ) {
    console.error(
      "Unable to capture original source map: initial map does not match the original source."
    );
    return null;
  }

  const topLevelBlocks = initialMap.blocks.filter(
    block => block.depth === 1
  );

  if (topLevelBlocks.length !== originalDocument.childCount) {
    console.error(
      "Unable to capture original source map: AST and ProseMirror block counts differ.",
      {
        astBlocks: topLevelBlocks.length,
        proseMirrorBlocks: originalDocument.childCount
      }
    );
    return null;
  }

  let previousEnd = 0;

  for (let index = 0; index < topLevelBlocks.length; index++) {
    const block = topLevelBlocks[index];

    if (
      !block ||
      !Number.isInteger(block.start) ||
      !Number.isInteger(block.end) ||
      block.start < previousEnd ||
      block.end <= block.start ||
      block.end > originalSource.length
    ) {
      console.error(
        "Unable to capture original source map: invalid block offsets.",
        { index, block }
      );
      return null;
    }

    const expectedExcerpt = originalSource
      .slice(block.start, block.end)
      .slice(0, 220);

    if (
      typeof block.source !== "string" ||
      block.source !== expectedExcerpt
    ) {
      console.error(
        "Unable to capture original source map: source excerpt validation failed.",
        { index, block }
      );
      return null;
    }

    previousEnd = block.end;
  }

  const snapshot = JSON.parse(JSON.stringify(initialMap));

  function freezeRecursively(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) {
      return value;
    }

    Object.values(value).forEach(freezeRecursively);
    return Object.freeze(value);
  }

  return freezeRecursively(snapshot);
}


function diagnoseProseMirrorInlineFormatting(record) {
  let view = null;

  record.crepe.editor.action(ctx => {
    view = ctx.get(editorViewCtx);
  });

  if (!view) {
    console.error("Unable to retrieve ProseMirror editor view.");
    return;
  }

  const doc = view.state.doc;
  const markedTextNodes = [];

  function visit(node, position, parentBlock = null) {
    if (node.isText) {
      if (node.marks.length > 0) {
        markedTextNodes.push({
          position,
          end: position + node.nodeSize,
          text: node.text,
          marks: node.marks.map(mark => mark.type.name),
          parentBlock
        });
      }
      return;
    }

    const currentBlock = [
      "paragraph",
      "heading",
      "blockquote",
      "bullet_list",
      "ordered_list",
      "list_item",
      "code_block"
    ].includes(node.type.name)
      ? node.type.name
      : parentBlock;

    if (!node.isLeaf) {
      node.forEach((child, offset) => {
        const childPosition =
          position + (node.type.name === "doc" ? 0 : 1) + offset;

        visit(child, childPosition, currentBlock);
      });
    }
  }

  visit(doc, 0);

  const selectedMap = record.originalSourceMap;

  if (
    !selectedMap ||
    selectedMap.sourceLength !== record.originalSource.length
  ) {
    console.error("Original source-map baseline is unavailable.");
    return;
  }

  const astTextNodes = (selectedMap.inlineNodes || [])
    .filter(node =>
      node.type === "text" &&
      node.parentInline?.some(parent => parent.type === "emphasis")
    );

  const comparisons = astTextNodes.map(astNode => {
    const candidates = markedTextNodes.filter(pmNode =>
      pmNode.text === astNode.value &&
      pmNode.parentBlock === astNode.parentBlock &&
      pmNode.marks.includes("emphasis")
    );

    const match = candidates.length === 1
      ? candidates[0]
      : null;

    return {
      text: astNode.value,
      parentBlock: astNode.parentBlock,
      sourceStart: astNode.start,
      sourceEnd: astNode.end,
      proseMirrorStart: match?.position ?? null,
      proseMirrorEnd: match?.end ?? null,
      matchCount: candidates.length,
      exactTextMatch: Boolean(match),
      emphasisMark: Boolean(match)
    };
  });

  console.group("LILAMAYA INLINE SOURCE CORRESPONDENCE");

  console.log("Remark emphasis text nodes:", astTextNodes.length);
  console.log("ProseMirror marked text nodes:", markedTextNodes.length);
  console.log("Unique exact matches:",
    comparisons.filter(item => item.exactTextMatch).length
  );

  console.log("AST-to-ProseMirror correspondence:");
  console.table(comparisons);

  console.log("Complete comparison data:", comparisons);
  console.log("CURRENT PROSEMIRROR MARKED-TEXT NODES:");
  console.table(markedTextNodes);

  console.groupEnd();
}

function inspectProseMirrorStructure(doc) {
  const blocks = [];

  const blockTypes = new Set([
    "heading",
    "paragraph",
    "blockquote",
    "bullet_list",
    "ordered_list",
    "list_item",
    "code_block",
    "horizontal_rule"
  ]);

  function visit(node, position, depth = 0) {
    if (blockTypes.has(node.type.name)) {
      blocks.push({
        type: node.type.name,
        position,
        nodeSize: node.nodeSize,
        depth,
        text: node.textContent.slice(0, 120)
      });
    }

    if (!node.isLeaf) {
      node.forEach((child, offset) => {
        const childPosition =
          position + (node.type.name === "doc" ? 0 : 1) + offset;

        visit(child, childPosition, depth + 1);
      });
    }
  }

  visit(doc, 0);
  return blocks;
}


function diagnoseSingleBlockSerialization(record) {
  const results = [];
  let doc = null;

  record.crepe.editor.action(ctx => {
    const schema = ctx.get(schemaCtx);
    const serializer = ctx.get(serializerCtx);
    doc = ctx.get(editorViewCtx).state.doc;

    doc.forEach((block, offset, index) => {
      try {
        const wrapper = schema.nodes.doc.create(null, [block]);
        results.push({
          index,
          offset,
          type: block.type.name,
          text: block.textContent.slice(0, 100),
          markdown: serializer(wrapper)
        });
      } catch (error) {
        results.push({
          index,
          offset,
          type: block.type.name,
          error: String(error)
        });
      }
    });
  });


  const selectedMap = record.originalSourceMap;
  const sourceMaps = record.crepe.lilamayaSourceMap || [];
  const pmBlocks = [];

  doc.forEach((block, offset, index) => {
    pmBlocks.push({
      index,
      type: block.type.name,
      text: block.textContent.slice(0, 100)
    });
  });

  const astBlocks = (selectedMap?.blocks || []).filter(
    block => block.depth === 1
  );
  const comparison = Array.from(
    { length: Math.max(astBlocks.length, pmBlocks.length) },
    (_, index) => {
      const ast = astBlocks[index];
      const pm = pmBlocks[index];

      return {
        index,
        astType: ast?.type ?? "MISSING",
        sourceStart: ast?.start ?? null,
        sourceEnd: ast?.end ?? null,
        originalMarkdown: ast?.source?.slice(0, 120) ?? null,
        pmType: pm?.type ?? "MISSING",
        pmText: pm?.text ?? null
      };
    }
  );

  console.group("LILAMAYA SOURCE TO EDITOR BLOCK COMPARISON");
  console.log("Source map entries:", sourceMaps.length);
  console.log("Source length:", selectedMap?.sourceLength);
  console.log("Original top-level blocks:", astBlocks.length);
  console.log("Editor top-level blocks:", pmBlocks.length);
  console.log("Block counts match:", astBlocks.length === pmBlocks.length);
  console.table(comparison);
  console.log("Full comparison JSON:", JSON.stringify(comparison, null, 2));
  console.groupEnd();

  console.group("LILAMAYA INDIVIDUAL BLOCK SERIALIZATION");
  console.log("Segment index:", record.segmentIndex);
  console.table(results);
  console.log(
    "FULL BLOCK SERIALIZATION JSON:",
    JSON.stringify(results, null, 2)
  );
  console.groupEnd();
}

function diagnoseCurrentBlockSerialization(record) {
  let results = [];

  record.crepe.editor.action(ctx => {
    const schema = ctx.get(schemaCtx);
    const serializer = ctx.get(serializerCtx);
    const doc = ctx.get(editorViewCtx).state.doc;

    doc.forEach((block, offset, index) => {
      try {
        const wrapper = schema.nodes.doc.create(null, [block]);
        const markdown = serializer(wrapper);

        results.push({
          index,
          offset,
          type: block.type.name,
          text: block.textContent,
          markdown
        });
      } catch (error) {
        results.push({
          index,
          offset,
          type: block.type.name,
          text: block.textContent,
          error: String(error)
        });
      }
    });
  });

  // Display every block, not just blocks matching an obsolete test filter.
  const relevant = results;

  console.group("LILAMAYA CURRENT BLOCK SERIALIZATION");

  console.log("Total current blocks:", results.length);
  console.log("Relevant blocks:", relevant.length);
  console.table(relevant);
  console.log("Complete relevant serialization:", relevant);

  console.groupEnd();
}


// Capture proof before editing: a pure Markdown parse has no source-backed ID,
// and the live node differs only by this exact active plugin-generated value.
function captureGeneratedHeadingProvenance(record) {
  if (record.originalDoc.childCount !== 1 ||
      record.originalDoc.firstChild.type.name !== "heading") return null;
  let proof = null;
  record.crepe.editor.action(ctx => {
    const parsed = ctx.get(parserCtx)(record.originalSource);
    if (!parsed || parsed.childCount !== 1 ||
        parsed.firstChild.type.name !== "heading" || parsed.firstChild.attrs.id !== "") return;
    const live = record.originalDoc.firstChild;
    const generator = ctx.get(headingIdGenerator.key);
    const generatedId = generator(live);
    if (typeof generatedId !== "string" || !generatedId || live.attrs.id !== generatedId) return;
    const restored = parsed.firstChild.type.create(
      {...parsed.firstChild.attrs, id: generatedId}, parsed.firstChild.content, parsed.firstChild.marks
    );
    if (!restored.eq(live)) return;
    proof = Object.freeze({source: record.originalSource, parsedDocument: parsed,
      generatedId, generator});
  });
  return proof;
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

  // Track node identity rather than guessing from an empty paragraph's shape.
  // The trailing plugin creates cursor scaffolding after terminal block nodes.
  // Source-backed and user-created paragraphs never enter this WeakSet.
  const generatedTrailingParagraphs = new WeakSet();
  crepe.editor.config(ctx => {
    ctx.update(trailingConfig.key, config => ({
      ...config,
      getNode(state) {
        const node = config.getNode(state);
        if (node?.type.name === "paragraph" && node.content.size === 0) {
          generatedTrailingParagraphs.add(node);
        }
        return node;
      }
    }));
  });
  crepe.lilamayaGeneratedTrailingParagraphs = generatedTrailingParagraphs;

  const searchExtension = createLilamayaSearchExtension();

  crepe.editor.use(searchExtension.extension);
  crepe.editor.use(createTransactionDiagnosticExtension());

  const sourceMap = [];
  crepe.editor.use(createSourceMapDiagnostic(sourceMap));
  crepe.lilamayaSourceMap = sourceMap;

  crepe.lilamayaSearchKey = searchExtension.key;

  return crepe;
}


function validatedLocalImagePath(markdown, prefix = "images/") {
  if (typeof prefix !== "string") return null;
  if (prefix !== "images/" && !/^\/images\/fragments\/[a-z0-9-]+\/$/i.test(prefix)) return null;
  if (typeof markdown !== "string") return null;
  const match = /^!\[[^\]]*\]\(([^)]+)\)$/.exec(markdown);
  if (!match || match[0] !== markdown) return null;
  const imagePath = match[1];
  if (!imagePath?.startsWith(prefix)) return null;
  const name = imagePath.slice(prefix.length);
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== ".." ? imagePath : null;
}


function resolveImagePreviewUrls(root, imageBaseUrl, imagePreviewUrls) {
  if (!root) return;

  root.querySelectorAll('img[src]').forEach(image => {
    const markdownPath = image.getAttribute("src");
    const previewUrl = imagePreviewUrls?.get(markdownPath);

    if (previewUrl) {
      image.setAttribute("src", previewUrl);
      return;
    }

    if (!markdownPath.startsWith("images/") || !imageBaseUrl) return;

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
  const documentType = options.documentType || "";
  const onRequestImage = options.onRequestImage;
  const imageBaseUrl = options.imageBaseUrl || "";
  const imageSourcePrefix = options.imageSourcePrefix ?? "images/";
  if (imageSourcePrefix !== "images/" && !/^\/images\/fragments\/[a-z0-9-]+\/$/i.test(imageSourcePrefix)) {
    throw new Error("Unsupported local image prefix.");
  }
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


  function isEditorAction(target) {
    return target instanceof Element && (toolbar.contains(target) || Boolean(target.closest(".editor-actions")));
  }

  function reconcileFocusedEditor(retainToolbarRecord = false) {
    if (destroyed) { activeEditor = null; return; }
    const focused = editors.filter(record => {
      const view = getEditorView(record);
      return !view.isDestroyed && view.hasFocus();
    });
    if (focused.length === 1) activeEditor = focused[0];
    else if (focused.length > 1 || !retainToolbarRecord || !editors.includes(activeEditor)) activeEditor = null;
  }

  function trackEditorFocus(record) {
    const synchronizeFocus = () => {
      if (!rebuilding && !destroyed && editors.includes(record)) reconcileFocusedEditor();
    };
    // A view may already have focus when its listeners are attached. Native
    // pointer/key interaction must reconcile that view even without a new focus event.
    for (const event of ["focus", "focusin", "pointerup", "keyup"]) {
      record.root.addEventListener(event, synchronizeFocus, true);
    }
    record.root.addEventListener("blur", event => {
      if (rebuilding || destroyed || !editors.includes(record)) return;
      const view = getEditorView(record);
      if (event.target === view.dom && event.relatedTarget && isEditorAction(event.relatedTarget)) {
        // The blur target proves which view just held genuine focus. Prefer any
        // differently focused view; never choose a merely default/previous row.
        const focused = editors.filter(item => getEditorView(item).hasFocus());
        activeEditor = focused.length === 1 ? focused[0] : focused.length ? null : record;
      } else reconcileFocusedEditor();
    }, true);
  }

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


  function diagnoseChangedBlocks(record) {
    const original = record.originalDoc;
    const current = getEditorView(record).state.doc;

    const originalBlocks = [];
    const currentBlocks = [];

    original.forEach((node, offset) => {
      originalBlocks.push({node, offset});
    });

    current.forEach((node, offset) => {
      currentBlocks.push({node, offset});
    });

    function inspectTextNodes(node) {
      const result = [];

      node.descendants(child => {
        if (child.isText) {
          result.push({
            text: child.text,
            textLength: child.text.length,
            marks: child.marks.map(mark => ({
              type: mark.type.name,
              attrs: mark.attrs
            }))
          });
        }
      });

      return result;
    }

    const comparison = Array.from(
      {length: Math.max(originalBlocks.length, currentBlocks.length)},
      (_, index) => {
        const before = originalBlocks[index];
        const after = currentBlocks[index];

        return {
          index,
          originalType: before?.node.type.name ?? "MISSING",
          currentType: after?.node.type.name ?? "MISSING",
          unchanged: before && after
            ? before.node.eq(after.node)
            : false,
          originalText: before?.node.textContent.slice(0, 100) ?? null,
          currentText: after?.node.textContent.slice(0, 100) ?? null,
          originalJSON: before?.node.toJSON() ?? null,
          currentJSON: after?.node.toJSON() ?? null,
          originalTextNodes: before
            ? inspectTextNodes(before.node)
            : null,
          currentTextNodes: after
            ? inspectTextNodes(after.node)
            : null
        };
      }
    );

    const changed = comparison.filter(item => !item.unchanged);

    console.group("LILAMAYA ORIGINAL-TO-CURRENT BLOCK COMPARISON");
    console.log("Original block count:", originalBlocks.length);
    console.log("Current block count:", currentBlocks.length);
    console.log("Changed blocks:", changed.length);
    console.table(comparison);
    console.log("Changed block details:", changed);
    console.groupEnd();
  }

  function diagnoseSourceReplacement(record) {
    const originalSource = record.originalSource;
    const originalDoc = record.originalDoc;
    const currentDoc = getEditorView(record).state.doc;
    console.group("LILAMAYA MULTIPLE-BLOCK SOURCE REPLACEMENT TEST");

    const selectedMap = record.originalSourceMap;

    if (!selectedMap) {
      console.error("STOPPED: No source map matches the original segment.");
      console.groupEnd();
      return;
    }

    if (originalDoc.childCount !== currentDoc.childCount) {
      console.error("STOPPED: Block counts differ. Structural edits are not supported by this test.");
      console.groupEnd();
      return;
    }

    const astBlocks = selectedMap.blocks.filter(
      block => block.depth === 1
    );

    const originalBlocks = [];
    const currentBlocks = [];

    originalDoc.forEach(node => originalBlocks.push(node));
    currentDoc.forEach(node => currentBlocks.push(node));

    const changedIndices = [];

    for (let index = 0; index < originalBlocks.length; index++) {
      if (!originalBlocks[index].eq(currentBlocks[index])) {
        changedIndices.push(index);
      }
    }

    console.log("Original source length:", originalSource.length);
    console.log("Original block count:", originalBlocks.length);
    console.log("Current block count:", currentBlocks.length);
    console.log("Changed block indices:", changedIndices);

    if (changedIndices.length < 2) {
      console.error("STOPPED: Please modify at least two existing blocks for this test.");
      console.groupEnd();
      return;
    }

    const replacements = [];

    for (const index of changedIndices) {
      const originalBlock = originalBlocks[index];
      const currentBlock = currentBlocks[index];
      const sourceBlock = astBlocks[index];

      if (
        !sourceBlock ||
        originalBlock.type.name !== currentBlock.type.name
      ) {
        console.error("STOPPED: Block correspondence is uncertain at index", index);
        console.groupEnd();
        return;
      }

      const start = sourceBlock.start;
      const end = sourceBlock.end;

      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end <= start ||
        end > originalSource.length
      ) {
        console.error("STOPPED: Invalid source offsets at index", index);
        console.groupEnd();
        return;
      }

      let serializedBlock = null;

      record.crepe.editor.action(ctx => {
        const schema = ctx.get(schemaCtx);
        const serializer = ctx.get(serializerCtx);
        const wrapper = schema.nodes.doc.create(null, [currentBlock]);

        serializedBlock = serializer(wrapper);
      });

      if (typeof serializedBlock !== "string") {
        console.error("STOPPED: Serialization failed at index", index);
        console.groupEnd();
        return;
      }

      replacements.push({
        index,
        start,
        end,
        original: originalSource.slice(start, end),
        replacement: serializedBlock
      });
    }

    const ordered = [...replacements].sort(
      (a, b) => a.start - b.start
    );

    for (let index = 1; index < ordered.length; index++) {
      if (ordered[index].start < ordered[index - 1].end) {
        console.error("STOPPED: Original source ranges overlap.");
        console.groupEnd();
        return;
      }
    }

    let proposedSource = originalSource;

    const descending = [...replacements].sort(
      (a, b) => b.start - a.start
    );

    for (const item of descending) {
      proposedSource =
        proposedSource.slice(0, item.start) +
        item.replacement +
        proposedSource.slice(item.end);
    }

    // Independently reconstruct the expected result from the
    // untouched original regions and the proposed replacements.
    let expectedSource = "";
    let cursor = 0;

    for (const item of ordered) {
      expectedSource += originalSource.slice(cursor, item.start);
      expectedSource += item.replacement;
      cursor = item.end;
    }

    expectedSource += originalSource.slice(cursor);

    console.log("Replacement count:", replacements.length);
    console.log("Replacement details:", replacements);
    console.log("Application order (descending offsets):",
      descending.map(item => ({
        index: item.index,
        start: item.start,
        end: item.end
      }))
    );

    console.log("Original source ranges overlap:", false);
    console.log(
      "Untouched source regions preserved exactly:",
      proposedSource === expectedSource
    );
    console.log("Original segment remains unchanged:",
      record.segment.content === originalSource
    );
    console.log("Proposed source length:", proposedSource.length);
    console.log("Original source length:", originalSource.length);
    console.log("PROPOSED MARKDOWN (NOT SAVED):", proposedSource);
    console.log(
      "Production segment matches independently reconstructed source:",
      record.segment.content === proposedSource
    );

    console.groupEnd();
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


  function serializeAuthoredParagraphRegion(ctx, nodes) {
    // The upstream doc runner strips its final empty paragraph unconditionally.
    // Proven cursor nodes have already been projected out. Serialize only the
    // selected authored region through the SAME schema/Remark processor, so
    // paragraphSchema can retain its existing <br /> representation.
    const state = new SerializerState(ctx.get(schemaCtx));
    state.openNode("root");
    state.next(ctx.get(schemaCtx).nodes.doc.create(null, nodes).content);
    return state.toString(ctx.get(remarkCtx));
  }

  function singleBlockAppend(record, originalBlocks, currentBlocks, plan, serializedRegions) {
    const supported = {table: "table", blockquote: "blockquote",
      bullet_list: "list", ordered_list: "list", heading: "heading"};
    // Milkdown's existing <br /> serialization round-trips empty paragraphs.
    // Extend only an unchanged single anchor + authored gaps + one final prose
    // paragraph. Never infer a gap from whitespace or omit an authored node.
    const emptyParagraph = node => node.type.name === "paragraph" && node.content.size === 0;
    const gapAppend = currentBlocks.length >= 2 && currentBlocks.slice(1).some(emptyParagraph) &&
      currentBlocks.slice(1, -1).every(emptyParagraph) &&
      currentBlocks.at(-1).type.name === "paragraph";
    if (originalBlocks.length !== 1 ||
        !(currentBlocks.length === 2 || gapAppend) ||
        !(supported[originalBlocks[0].type.name] ||
          (gapAppend && originalBlocks[0].type.name === "paragraph")) ||
        currentBlocks.at(-1).type.name !== "paragraph") return null;

    const fail = message => { throw new Error("Cannot safely append paragraph: " + message); };
    if (!originalBlocks[0].eq(currentBlocks[0]) ||
        plan.anchors.length !== 1 || plan.anchors[0].originalIndex !== 0 ||
        plan.anchors[0].currentIndex !== 0 || plan.regions.length !== 1) {
      fail("the original block is not an exact, unique unchanged anchor.");
    }
    const region = plan.regions[0];
    if (region.originalStart !== 1 || region.originalEnd !== 1 ||
        region.currentStart !== 1 || region.currentEnd !== currentBlocks.length ||
        serializedRegions.length !== 1) fail("the change is not a proven append-only paragraph sequence.");

    const source = record.originalSource;
    const map = captureOriginalSourceMap([record.originalSourceMap], source, record.originalDoc);
    if (!map) fail("the original source map cannot be revalidated.");
    const blocks = map.blocks.filter(block => block.depth === 1);
    if (blocks.length !== 1 || blocks[0].type !== (supported[originalBlocks[0].type.name] || "paragraph")) {
      fail("the source block does not match the document anchor.");
    }
    const block = blocks[0];
    const prefix = source.slice(0, block.start), suffix = source.slice(block.end);
    if (!/^[ \t\r\n]*$/.test(prefix) || !/^(?:\r\n|\n)*$/.test(suffix)) {
      fail("source-owned boundary whitespace cannot be preserved unambiguously.");
    }
    const endings = source.match(/\r\n|\r|\n/g) || [];
    const kinds = new Set(endings);
    if (kinds.size !== 1 || kinds.has("\r")) fail("line endings are mixed or indeterminate.");
    const eol = endings[0];
    let added = serializedRegions[0];
    if (typeof added !== "string" || !added.trim() || /\r(?!\n)/.test(added)) {
      fail("the new paragraph has no unambiguous serialization.");
    }
    // Only newly serialized bytes are normalized. Original bytes are never rewritten.
    added = added.replace(/\r?\n$/, "").replace(/\r\n|\n/g, eol);
    const candidate = source.slice(0, block.end) + eol + eol + added + suffix;
    const segmented = parseHugoDocument(candidate);
    if (segmented.frontmatter !== "" || segmented.segments.length !== 1 ||
        segmented.segments[0].type !== "markdown" || segmented.segments[0].content !== candidate) {
      fail("the insertion would create or cross a protected shortcode boundary.");
    }
    let parsed, expected;
    record.crepe.editor.action(ctx => {
      parsed = ctx.get(parserCtx)(candidate);
      expected = ctx.get(schemaCtx).nodes.doc.create(null, currentBlocks);
      const proof = record.generatedHeadingProvenance;
      if (parsed && !parsed.eq(expected) && proof &&
          originalBlocks[0].type.name === "heading" &&
          proof.source === source && parsed.childCount === currentBlocks.length &&
          parsed.firstChild.eq(proof.parsedDocument.firstChild) &&
          ctx.get(headingIdGenerator.key) === proof.generator &&
          proof.generator(originalBlocks[0]) === proof.generatedId &&
          originalBlocks[0].attrs.id === proof.generatedId) {
        // Revalidate provenance with today's parser; explicit parsed IDs or any
        // other source-backed differences cannot enter this normalization path.
        const baseline = ctx.get(parserCtx)(source);
        if (baseline && baseline.eq(proof.parsedDocument)) {
          const heading = parsed.firstChild;
          const restored = heading.type.create(
            {...heading.attrs, id: proof.generatedId}, heading.content, heading.marks
          );
          if (restored.eq(originalBlocks[0])) {
            parsed = parsed.copy(parsed.content.replaceChild(0, restored));
          }
        }
      }
    });
    if (!parsed || !parsed.eq(expected)) fail("reparsed Markdown differs from the intended document.");
    return candidate;
  }

  // A single deliberate paragraph conversion has an exact source slot. Other
  // blocks remain unchanged anchors; never broaden the general mismatch path.
  function synchronizeParagraphConversion(record, originalBlocks, currentBlocks) {
    const changedTypes = originalBlocks.map((node, index) =>
      node.type !== currentBlocks[index].type ? index : -1
    ).filter(index => index >= 0);
    if (!changedTypes.length) return null;
    const fail = message => { throw new Error("Cannot safely convert paragraph: " + message + " Your unsaved draft is retained."); };
    if (changedTypes.length !== 1) fail("only one block conversion at a time is supported.");
    const index = changedTypes[0];
    const original = originalBlocks[index], current = currentBlocks[index];
    const type = current.type.name;
    if (original.type.name !== "paragraph" ||
        !["heading", "blockquote", "bullet_list", "ordered_list"].includes(type)) {
      fail("this block-type conversion is not supported.");
    }
    if (originalBlocks.some((node, i) => i !== index && !node.eq(currentBlocks[i]))) {
      fail("another source-backed block changed; its correspondence is uncertain.");
    }
    const inner = type === "heading" ? current :
      type === "blockquote" ? current.firstChild : current.firstChild?.firstChild;
    if ((type === "blockquote" && current.childCount !== 1) ||
        (["bullet_list", "ordered_list"].includes(type) &&
          (current.childCount !== 1 || current.firstChild.type.name !== "list_item" ||
           current.firstChild.childCount !== 1)) ||
        !inner || (type !== "heading" && inner.type.name !== "paragraph")) {
      fail("only a heading or a single wrapped paragraph is supported.");
    }
    const source = record.originalSource;
    const map = captureOriginalSourceMap([record.originalSourceMap], source, record.originalDoc);
    if (!map) fail("the original source map could not be revalidated.");
    const block = map.blocks.filter(item => item.depth === 1)[index];
    if (block?.type !== "paragraph") fail("the source slot is not a paragraph.");
    // Invisible comments must not be lost when serializing an edited block.
    if (/<!--|-->|\{\{[<%]/.test(source.slice(block.start, block.end))) {
      fail("the selected source contains a comment or protected boundary.");
    }
    const endings = new Set(source.match(/\r\n|\r|\n/g) || []);
    if (endings.size > 1 || endings.has("\r")) fail("source line endings are ambiguous.");
    const eol = [...endings][0] || "\n";
    let candidate;
    record.crepe.editor.action(ctx => {
      const parser = ctx.get(parserCtx), schema = ctx.get(schemaCtx);
      const baseline = parser(source);
      const freshMap = record.crepe.lilamayaSourceMap.at(-1);
      if (!baseline || baseline.childCount !== originalBlocks.length ||
          !baseline.child(index).eq(original) || !freshMap ||
          freshMap.sourceLength !== map.sourceLength ||
          JSON.stringify(freshMap.blocks) !== JSON.stringify(map.blocks)) {
        fail("the parser and saved source map no longer prove the same paragraph slot.");
      }
      let serialized = ctx.get(serializerCtx)(schema.nodes.doc.create(null, [current]));
      if (typeof serialized !== "string" || !serialized.trim() || /\r(?!\n)/.test(serialized)) {
        fail("the converted block has no safe serialization.");
      }
      // Paragraph AST ranges exclude their final source-owned line ending.
      // Strip one serializer terminator, normalize only new bytes, and retain
      // every original byte outside this deliberately modified block.
      serialized = serialized.replace(/\r?\n$/, "").replace(/\r\n|\n/g, eol);
      const converted = parser(serialized);
      if (!converted || converted.childCount !== 1) fail("the conversion reparses as multiple blocks.");
      let reparsed = converted.firstChild;
      if (!reparsed.eq(current) && type === "heading" &&
          reparsed.type === current.type && reparsed.attrs.id === "" &&
          typeof current.attrs.id === "string" && current.attrs.id &&
          ctx.get(headingIdGenerator.key)(current) === current.attrs.id) {
        // This paragraph had no source-backed heading ID. Only the exact active
        // plugin-generated ID may differ; all content, marks and other attrs
        // must still compare exactly. Arbitrary IDs cannot pass this proof.
        reparsed = reparsed.type.create(
          {...reparsed.attrs, id: current.attrs.id}, reparsed.content, reparsed.marks
        );
      }
      if (!reparsed.eq(current) && ["bullet_list", "ordered_list"].includes(type) &&
          reparsed.type === current.type && reparsed.childCount === 1 &&
          current.attrs.spread === false && reparsed.firstChild.childCount === 1 &&
          reparsed.firstChild.firstChild.type.name === "paragraph" &&
          current.firstChild.type.defaultAttrs.spread === true &&
          current.firstChild.attrs.spread === true && reparsed.firstChild.attrs.spread === false) {
        // wrapIn creates this item's schema-default spread=true, but one sole
        // paragraph has no inter-block blank line to encode. The original slot
        // was a paragraph, not a source-backed list. Restore only that generated
        // default for comparison; every other attribute and child must match.
        const item = reparsed.firstChild.type.create(
          {...reparsed.firstChild.attrs, spread: true}, reparsed.firstChild.content, reparsed.firstChild.marks
        );
        reparsed = reparsed.copy(reparsed.content.replaceChild(0, item));
      }
      if (!reparsed.eq(current)) fail("serialized content or attributes differ from the intended block.");
      candidate = applySourceReplacements(source, [{index, start: block.start, end: block.end, replacement: serialized}]);
      const segmented = parseHugoDocument(candidate);
      if (segmented.frontmatter !== "" || segmented.segments.length !== 1 ||
          segmented.segments[0].type !== "markdown" || segmented.segments[0].content !== candidate) {
        fail("the conversion would create or cross a protected boundary.");
      }
      // Compare in the pure parser domain: unchanged source-backed headings keep
      // their exact parsed attrs. No attributes on surrounding nodes are ignored.
      const expectedNodes = []; baseline.forEach(node => expectedNodes.push(node));
      expectedNodes[index] = converted.firstChild;
      const expected = schema.nodes.doc.create(null, expectedNodes);
      const parsed = parser(candidate);
      if (!parsed || !parsed.eq(expected)) fail("surrounding source changes the reparsed document structure.");
    });
    return candidate;
  }


  // Preserve literal text edits in whitespace-sensitive paragraphs by source
  // offsets. In particular, do not ask the serializer to canonicalize an
  // untouched two-space/backslash hard break or terminal horizontal whitespace.
  function synchronizeParagraphWhitespace(record, index, original, current, block) {
    if (original.type.name !== "paragraph" || current.type !== original.type || block.type !== "paragraph") return null;
    const source = record.originalSource;
    const raw = source.slice(block.start, block.end);
    const oldNodes = [], newNodes = [];
    original.forEach(node => oldNodes.push(node)); current.forEach(node => newNodes.push(node));
    if (!/[ \t]+(?=\r?$)/m.test(raw) && !oldNodes.some(node => node.type.name === "hardbreak")) return null;
    const fail = reason => { throw new Error("Cannot safely preserve paragraph whitespace: " + reason); };
    if (!captureOriginalSourceMap([record.originalSourceMap], source, record.originalDoc)) fail("invalid original source map.");
    if (oldNodes.length !== newNodes.length) fail("inline structure changed; preserve the draft before reconciling.");
    const spans = record.originalSourceMap.inlineNodes?.filter(node =>
      node.type === "text" && node.parentBlock === "paragraph" && node.parentStart === block.start);
    if (!spans || spans.length !== oldNodes.filter(node => node.isText).length) fail("text correspondence is uncertain.");
    const changes = []; let textIndex = 0, previousEnd = block.start;
    for (let i = 0; i < oldNodes.length; i++) {
      const before = oldNodes[i], after = newNodes[i];
      if (!before.sameMarkup(after)) fail("inline marks or attributes changed.");
      if (!before.isText) {
        if (before.type.name !== "hardbreak" || !before.eq(after)) fail("non-text structure changed.");
        continue;
      }
      const span = spans[textIndex++];
      if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < previousEnd ||
          span.end > block.end || span.end < span.start + before.text.length ||
          source.slice(span.start, span.start + before.text.length) !== before.text ||
          !/^[ \t]*$/.test(source.slice(span.start + before.text.length, span.end)) ||
          span.source !== source.slice(span.start, span.end).slice(0, 160)) fail("text source offsets or excerpts do not match.");
      previousEnd = span.end;
      if (before.text !== after.text) changes.push({start:span.start, end:span.start + before.text.length, replacement:after.text});
    }
    if (!changes.length) fail("no validated text edit.");
    const candidate = applySourceReplacements(source, changes);
    const segmented = parseHugoDocument(candidate);
    if (segmented.frontmatter !== "" || segmented.segments.length !== 1 ||
        segmented.segments[0].type !== "markdown" || segmented.segments[0].content !== candidate) fail("protected boundary changed.");
    record.crepe.editor.action(ctx => {
      const parser = ctx.get(parserCtx), baseline = parser(source);
      if (!baseline || baseline.childCount !== record.originalDoc.childCount || !baseline.child(index).eq(original)) fail("original paragraph cannot be reproven.");
      const expected = baseline.copy(baseline.content.replaceChild(index, current));
      const parsed = parser(candidate);
      if (!parsed || !parsed.eq(expected)) fail("proposed source does not exactly match the intended document.");
    });
    return {start:block.start, end:block.end, replacement:candidate.slice(block.start,
      block.end + candidate.length - source.length)};
  }

  function verifyIntentionalEmptyInsertion(record, originalBlocks, currentBlocks, plan, candidate) {
    const empty = node => node.type.name === "paragraph" && node.content.size === 0;
    if (!plan.regions.some(region => currentBlocks.slice(region.currentStart, region.currentEnd).some(empty))) return;
    if (!captureOriginalSourceMap([record.originalSourceMap], record.originalSource, record.originalDoc)) {
      throw new Error("Cannot safely preserve intentional empty paragraphs: invalid source map.");
    }
    const fail = reason => { throw new Error("Cannot safely preserve intentional empty paragraphs: " + reason); };
    if (!plan.anchors.length || plan.regions.some(region => region.originalStart !== region.originalEnd ||
        currentBlocks.slice(region.currentStart, region.currentEnd).some(node => node.type.name !== "paragraph"))) {
      fail("unchanged anchors and paragraph-only insertions are required.");
    }
    const segmented = parseHugoDocument(candidate);
    if (segmented.frontmatter !== "" || segmented.segments.length !== 1 ||
        segmented.segments[0].type !== "markdown" || segmented.segments[0].content !== candidate) fail("protected boundary changed.");
    record.crepe.editor.action(ctx => {
      const parser=ctx.get(parserCtx), baseline=parser(record.originalSource);
      if (!baseline || baseline.childCount !== originalBlocks.length) fail("source baseline changed.");
      const expected=[...currentBlocks];
      for (const anchor of plan.anchors) {
        const original=originalBlocks[anchor.originalIndex], live=currentBlocks[anchor.currentIndex];
        let pure=baseline.child(anchor.originalIndex);
        if (!original.eq(live)) fail("anchor changed.");
        if (!pure.eq(original)) {
          if (pure.type.name !== "heading" || pure.attrs.id !== "" || original.type !== pure.type ||
              !original.attrs.id || ctx.get(headingIdGenerator.key)(original) !== original.attrs.id ||
              !pure.type.create({...pure.attrs,id:original.attrs.id},pure.content,pure.marks).eq(original)) fail("source anchor attributes cannot be proven.");
        }
        expected[anchor.currentIndex]=pure;
      }
      const parsed=parser(candidate), wanted=ctx.get(schemaCtx).nodes.doc.create(null,expected);
      if (!parsed || !parsed.eq(wanted)) fail("serialization changed the intended node structure.");
    });
  }

  function synchronizeSegments() {
    for (const record of editors) {
      const originalSource = record.originalSource;
      const originalDocument = record.originalDoc;
      const currentDocument = getEditorView(record).state.doc;

      if (
        typeof originalSource !== "string" ||
        !originalDocument
      ) {
        throw new Error(
          "Cannot safely synchronize: the original Markdown baseline is missing."
        );
      }

      if (currentDocument.eq(originalDocument)) {
        record.segment.content = originalSource;
        continue;
      }

      if (/^\s*$/.test(originalSource)) {
        let serializedDocument = null;

        record.crepe.editor.action(ctx => {
          const serializer = ctx.get(serializerCtx);
          const nodes = []; currentDocument.forEach(node => nodes.push(node));
          const original = []; originalDocument.forEach(node => original.push(node));
          if (isGeneratedTrailingCursor(nodes, record.crepe.lilamayaGeneratedTrailingParagraphs, original)) nodes.pop();
          const projected = currentDocument.copy(currentDocument.content.constructor.fromArray(nodes));
          const authoredEmpty = nodes.length > 1 && nodes.some(node => node.type.name === "paragraph" && node.content.size === 0);
          serializedDocument = authoredEmpty ? serializeAuthoredParagraphRegion(ctx, nodes) : serializer(projected);
          const trailingProtected = record.segmentIndex > 0 && record.segmentIndex === segments.length - 1 &&
            segments[record.segmentIndex] === record.segment && segments[record.segmentIndex - 1]?.type !== "markdown";
          if (authoredEmpty || trailingProtected) {
            const endings = originalSource.match(/\r\n|\r|\n/g) || [];
            if (!/^[ \t\r\n]*$/.test(originalSource) || new Set(endings).size > 1 || endings.includes("\r")) {
              throw new Error("Cannot safely preserve intentional empty paragraphs: ambiguous opening whitespace.");
            }
            const candidate = originalSource + serializedDocument.replace(/\r\n|\n/g, endings[0] || "\n");
            const segmented = parseHugoDocument(candidate);
            if (segmented.frontmatter !== "" || segmented.segments.length !== 1 ||
                segmented.segments[0].type !== "markdown" || segmented.segments[0].content !== candidate) {
              throw new Error("Cannot safely preserve intentional empty paragraphs: protected boundary changed.");
            }
            let parsed = ctx.get(parserCtx)(candidate);
            if (parsed && parsed.childCount === nodes.length) {
              const compared = [];
              parsed.forEach((node, offset, index) => {
                const live=nodes[index];
                if (!node.eq(live) && node.type.name === "heading" && node.attrs.id === "" &&
                    live.type === node.type && live.attrs.id && ctx.get(headingIdGenerator.key)(live) === live.attrs.id &&
                    node.type.create({...node.attrs,id:live.attrs.id},node.content,node.marks).eq(live)) {
                  node=node.type.create({...node.attrs,id:live.attrs.id},node.content,node.marks);
                }
                compared.push(node);
              });
              parsed=parsed.copy(parsed.content.constructor.fromArray(compared));
            }
            if (!parsed || !parsed.eq(projected)) throw new Error("Cannot safely preserve intentional empty paragraphs: parser round-trip mismatch.");
            serializedDocument = candidate;
          }
        });

        if (typeof serializedDocument !== "string") {
          throw new Error(
            "Cannot safely synchronize: complete document serialization failed."
          );
        }

        record.segment.content = serializedDocument;
        continue;
      }

      const originalBlocks = [];
      const currentBlocks = [];

      originalDocument.forEach(node => originalBlocks.push(node));
      currentDocument.forEach(node => currentBlocks.push(node));

      // Omit only the exact, still-empty cursor node created by Milkdown.
      // Never infer provenance from shape or strip source-backed paragraphs.
      if (isGeneratedTrailingCursor(currentBlocks,
          record.crepe.lilamayaGeneratedTrailingParagraphs, originalBlocks)) {
        currentBlocks.pop();
      }

      const selectedMap = record.originalSourceMap;

      if (
        !selectedMap ||
        selectedMap.sourceLength !== originalSource.length ||
        !Array.isArray(selectedMap.blocks)
      ) {
        throw new Error(
          "Cannot safely synchronize: the validated original source-map baseline is missing."
        );
      }

      const sourceBlocks = selectedMap.blocks.filter(
        block => block.depth === 1
      );

      if (sourceBlocks.length !== originalBlocks.length) {
        throw new Error(
          "Cannot safely synchronize: source-map and document block counts differ."
        );
      }

      // Structural reconciliation is used only when block counts differ.
      if (originalBlocks.length !== currentBlocks.length) {
        const plan = planNodeReconciliation(originalBlocks, currentBlocks);

        const serializedRegions = plan.regions.map(region => {
          if (region.currentStart === region.currentEnd) {
            return "";
          }

          let serialized = null;

          record.crepe.editor.action(ctx => {
            const schema = ctx.get(schemaCtx);
            const serializer = ctx.get(serializerCtx);
            const wrapper = schema.nodes.doc.create(
              null,
              currentBlocks.slice(region.currentStart, region.currentEnd)
            );

            const authored = currentBlocks.slice(region.currentStart, region.currentEnd);
            serialized = authored.some(node => node.type.name === "paragraph" && node.content.size === 0)
              ? serializeAuthoredParagraphRegion(ctx, authored) : serializer(wrapper);
          });

          if (typeof serialized !== "string") {
            throw new Error(
              "Cannot safely synchronize: structural region serialization failed."
            );
          }

          if (currentBlocks.slice(region.currentStart, region.currentEnd).some(node =>
              node.type.name === "paragraph" && node.content.size === 0)) {
            const endings = originalSource.match(/\r\n|\r|\n/g) || [];
            if (new Set(endings).size !== 1 || endings[0] === "\r") {
              throw new Error("Cannot safely preserve intentional empty paragraphs: mixed or indeterminate line endings.");
            }
            // Normalize only newly authored serialization; source-owned separators stay exact.
            serialized = serialized.replace(/\r\n|\n/g, endings[0]);
          }

          if (!serialized.trim()) {
            throw new Error(
              "Cannot safely synchronize: a structural insertion contains no serializable content."
            );
          }

          return serialized;
        });

        const appended = singleBlockAppend(
          record, originalBlocks, currentBlocks, plan, serializedRegions
        );
        if (appended !== null) {
          record.segment.content = appended;
          continue;
        }

        const replacements = buildSeparatorAwareReplacements(
          originalSource,
          sourceBlocks,
          plan,
          serializedRegions
        );

        const candidate = applySourceReplacements(originalSource, replacements);
        verifyIntentionalEmptyInsertion(record, originalBlocks, currentBlocks, plan, candidate);
        record.segment.content = candidate;

        continue;
      }

      const converted = synchronizeParagraphConversion(record, originalBlocks, currentBlocks);
      if (converted !== null) {
        record.segment.content = converted;
        continue;
      }

      // Preserve the established same-count, block-by-block editing path.
      const replacements = [];

      for (let index = 0; index < originalBlocks.length; index++) {
        const originalBlock = originalBlocks[index];
        const currentBlock = currentBlocks[index];

        if (originalBlock.eq(currentBlock)) {
          continue;
        }

        const sourceBlock = sourceBlocks[index];

        if (
          !sourceBlock ||
          originalBlock.type.name !== currentBlock.type.name
        ) {
          throw new Error(
            "Cannot safely synchronize: block correspondence is uncertain at index " +
            index + "."
          );
        }

        const start = sourceBlock.start;
        const end = sourceBlock.end;

        if (
          !Number.isInteger(start) ||
          !Number.isInteger(end) ||
          start < 0 ||
          end <= start ||
          end > originalSource.length
        ) {
          throw new Error(
            "Cannot safely synchronize: invalid original source offsets at block " +
            index + "."
          );
        }

        const preservedWhitespace = synchronizeParagraphWhitespace(
          record, index, originalBlock, currentBlock, sourceBlock
        );
        if (preservedWhitespace) {
          replacements.push({index, ...preservedWhitespace});
          continue;
        }

        let serializedBlock = null;

        record.crepe.editor.action(ctx => {
          const schema = ctx.get(schemaCtx);
          const serializer = ctx.get(serializerCtx);
          const wrapper = schema.nodes.doc.create(
            null,
            [currentBlock]
          );

          serializedBlock = serializer(wrapper);
        });

        if (typeof serializedBlock !== "string") {
          throw new Error(
            "Cannot safely synchronize: block serialization failed at index " +
            index + "."
          );
        }

        // These Remark block ranges exclude the final source line ending.
        // Remove exactly one serializer terminator, never source whitespace.
        if (sourceBlock.type === "paragraph" || sourceBlock.type === "table" ||
            (sourceBlock.type === "html" && originalBlock.type.name === "paragraph" &&
             originalBlock.content.size === 0 && originalSource.slice(start, end) === "<br />")) {
          serializedBlock = serializedBlock.replace(/\r?\n$/, "");
        }

        replacements.push({
          index,
          start,
          end,
          replacement: serializedBlock
        });
      }

      record.segment.content = applySourceReplacements(
        originalSource,
        replacements
      );
    }
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
      // Only intentionally edited payload is reconstructed; retain its EOL convention.
      const styles = [...new Set(segment.content.match(/\r\n|\r|\n/g) || [])];
      const eol = styles.length === 1 && styles[0] !== "\r" ? styles[0] : "\n";
      segment.content = createShortcodeContent(
        segment.type,
        textarea.value.replace(/\n/g, eol),
        eol
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


  function emptyProtectedBodyIndex() {
    const index = segments.length - 1;
    return index > 0 && segments[index]?.type === "markdown" &&
      segments[index].content.trim() === "" && segments[index - 1]?.type !== "markdown" ? index : -1;
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
      const emptyBodyIndex = emptyProtectedBodyIndex();
      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];

        if (segment.type !== "markdown") {
          content.appendChild(
            renderProtectedSegment(segment)
          );

          continue;
        }

        if (segment.content.trim() === "" && index !== focusIndex && index !== emptyBodyIndex) {
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
        record.originalSource = segment.content;
        record.originalDoc = sourceBackedBaselineDocument(
          getEditorView(record).state.doc,
          record.crepe.lilamayaSourceMap?.[0],
          record.crepe.lilamayaGeneratedTrailingParagraphs
        );
        record.originalSourceMap = captureOriginalSourceMap(
          record.crepe.lilamayaSourceMap,
          record.originalSource,
          record.originalDoc
        );
        record.generatedHeadingProvenance = captureGeneratedHeadingProvenance(record);
        diagnoseSingleBlockSerialization(record);
    console.group("LILAMAYA SOURCE FIDELITY DIAGNOSTIC");

    console.log(
      "REMARK AST SOURCE MAP:",
      JSON.stringify(record.crepe.lilamayaSourceMap, null, 2)
    );

    console.log(
      "PROSEMIRROR DOCUMENT:",
      JSON.stringify(
        inspectProseMirrorStructure(record.originalDoc),
        null,
        2
      )
    );

    console.groupEnd();


        // Keep the original ProseMirror document as a fidelity reference.
        // If the editor returns to this exact state, preserve the original Markdown.

        resolveImagePreviewUrls(editorRoot, imageBaseUrl, imagePreviewUrls);

        trackEditorFocus(record);

        editorRoot.addEventListener("input", () => {
          record.dirty = true;
          if (searchInput.value) refreshSearch(false);
        });

        editors.push(record);

        reconcileFocusedEditor();
      }

      rebuilding = false;
      reconcileFocusedEditor();
      updateShortcodeChoices();
      if (searchInput.value) refreshSearch(false);

      if (focusIndex >= 0) {
        const target = editors.find(
          record => record.segmentIndex === focusIndex
        );

        if (target) {
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
          reconcileFocusedEditor();
        }
      }

    } catch (error) {
      rebuilding = false;
      throw error;
    }
  }


  function shortcodeAllowed(kind) {
    if (kind === "introduction") return documentType === "essays";
    if (kind === "invocation") return documentType === "fragments";
    return kind === "poetry" && ["essays", "paintings", "people", "works", "ideas", "traditions", "places", "journeys"].includes(documentType);
  }

  function updateShortcodeChoices() {
    for (const option of shortcodeSelect.options) {
      if (!option.value) continue;
      option.disabled = !shortcodeAllowed(option.value) ||
        (option.value === "introduction" && segments.some(segment => segment.type === "introduction"));
    }
  }

  async function insertShortcode(kind) {
    const fail = message => { throw new Error("Cannot safely insert shortcode: " + message + " Your draft was not changed."); };
    if (!shortcodeAllowed(kind)) fail("this shortcode is unavailable for the loaded document type.");
    if (kind === "introduction" && segments.some(segment => segment.type === "introduction")) fail("an Introduction already exists.");
    const record = activeEditor;
    if (!record || destroyed || rebuilding || !editors.includes(record)) fail("no active editor is available.");
    const view = getEditorView(record), selection = view.state.selection;
    if (!selection.empty || selection.from !== selection.to || selection.$from.depth !== 1 ||
        selection.$from.parent.type.name !== "paragraph" || selection.$from.parentOffset !== selection.$from.parent.content.size) {
      fail("use a collapsed cursor at a top-level paragraph end.");
    }
    const segmentIndex = segments.indexOf(record.segment);
    if (segmentIndex < 0) fail("the selected segment is stale.");
    const previous = segments.map(segment => ({segment, content:segment.content}));
    const savedDocument = view.state.doc, from = selection.from;
    let replacement, committed = false, renderBaseline = null;
    const frozen = [];
    try {
      synchronizeSegments();
      const source = record.segment.content;
      let baseline, empty = false;
      if (/^[ \t\r\n]*$/.test(source)) {
        if (!validateEmptyOpeningImageSource(record) || source !== record.originalSource) fail("the empty body cannot be proven.");
        record.crepe.editor.action(ctx => {
          const parser=ctx.get(parserCtx), maps=record.crepe.lilamayaSourceMap, count=maps.length;
          const parsed=parser(source), canonical=ctx.get(schemaCtx).nodes.doc.create(null,[ctx.get(schemaCtx).nodes.paragraph.create()]);
          const map=maps[count];
          if (maps.length!==count+1 || !parsed?.eq(canonical) || !savedDocument.eq(canonical) || from!==1 ||
              map?.sourceLength!==source.length || map.blocks.length || map.inlineNodes.length) fail("the empty source and paragraph do not correspond.");
          baseline={source,parsed,parser,map}; empty=true;
        });
      } else baseline=captureImageSourceBaseline(record);
      if (!view.state.doc.eq(savedDocument) || view.state.selection.from!==from || !view.state.selection.empty) fail("the cursor changed.");
      let offset=source.length, blockIndex=-1;
      if (!empty) {
        baseline.parsed.forEach((node,pos,index) => {
          if(node.type.name==="paragraph" && from===pos+node.nodeSize-1) blockIndex=index;
        });
        const map=captureOriginalSourceMap([baseline.map],source,baseline.parsed);
        const block=map?.blocks.filter(node=>node.depth===1)[blockIndex];
        if (!block || block.type!=="paragraph" || blockIndex<0) fail("the paragraph has no source-backed boundary.");
        offset=block.end;
      }
      let styles = new Set(source.match(/\r\n|\r|\n/g) || []);
      if (!styles.size) styles = new Set((documentModel.frontmatter + segments.map(segment=>segment.content).join("")).match(/\r\n|\r|\n/g) || []);
      if (styles.size>1 || styles.has("\r")) fail("the line-ending style is ambiguous.");
      const eol=[...styles][0] || "\n";
      const definition=createShortcodeSegment(kind); definition.content=definition.content.replace(/\n/g,eol);
      const left=source.slice(0,offset)+eol+eol, right=eol+source.slice(offset);
      const candidate=left+definition.content+right, model=parseHugoDocument(candidate);
      if(model.frontmatter!=="" || model.segments.length!==3 || model.segments[0].type!=="markdown" ||
          model.segments[0].content!==left || model.segments[1].type!==kind || model.segments[1].content!==definition.content ||
          model.segments[2].type!=="markdown" || model.segments[2].content!==right) fail("the protected boundaries are not exact.");
      record.crepe.editor.action(ctx=>{
        if(ctx.get(parserCtx)!==baseline.parser) fail("the parser changed.");
        const parser=baseline.parser, before=parser(source), nodes=[]; before?.forEach(node=>nodes.push(node));
        if(!before?.eq(baseline.parsed)) fail("the source baseline changed.");
        const expected = list => ctx.get(schemaCtx).nodes.doc.create(null,list.length?list:[ctx.get(schemaCtx).nodes.paragraph.create()]);
        if(!parser(left)?.eq(expected(empty?[]:nodes.slice(0,blockIndex+1))) ||
            !parser(right)?.eq(expected(empty?[]:nodes.slice(blockIndex+1)))) fail("untouched Markdown structure would change.");
      });
      if (!view.state.doc.eq(savedDocument) || view.state.selection.from!==from || !view.state.selection.empty ||
          record.segment.content!==source || destroyed || rebuilding) fail("the operation baseline is stale.");
      renderBaseline=segments.map(segment=>({segment,content:segment.content}));
      replacement=model.segments; replacement[1].restoreContent=source;
      // Freeze editing only during asynchronous destruction/recreation of views.
      for(const item of editors) { const editorView=getEditorView(item); frozen.push({editorView,editable:editorView.props.editable}); editorView.setProps({editable:()=>false}); }
      segments.splice(segmentIndex,1,...replacement); committed=true;
      await rebuildSegments(segmentIndex+2);
    } catch(error) {
      const restore = committed ? renderBaseline : previous;
      for(const item of restore) item.segment.content=item.content;
      if(committed) {
        segments.splice(0,segments.length,...restore.map(item=>item.segment));
        try {
          await rebuildSegments(segmentIndex);
          const restored=editors.find(item=>item.segment===record.segment);
          if(restored) { const v=getEditorView(restored); v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc,from))); }
        } catch(restoreError) {
          const failure=new Error("Shortcode rendering and restoration failed; preserve the retained source snapshot.");
          failure.sourceSnapshot=restore.map(item=>({type:item.segment.type,content:item.content})); failure.cause=restoreError; throw failure;
        }
      }
      throw error;
    } finally {
      for(const item of frozen) if(!item.editorView.isDestroyed) item.editorView.setProps({editable:item.editable});
    }
  }

  // A zero-byte placeholder has no source-owned blocks or insertion offsets.
  // Prove its canonical paragraph exactly; whitespace and hidden content are
  // deliberately ineligible, even when they render as an empty paragraph.
  function isZeroByteImagePlaceholder(record, source, document, parsed, map) {
    const emptyMap = value => value?.sourceLength === 0 &&
      Array.isArray(value.blocks) && value.blocks.length === 0 &&
      Array.isArray(value.inlineNodes) && value.inlineNodes.length === 0;
    if (source !== "" || record.originalSource !== "" ||
        record.originalSourceMap !== null || !parsed || !emptyMap(map) ||
        !emptyMap(record.crepe.lilamayaSourceMap?.[0])) return false;
    const paragraph = parsed.type.schema.nodes.paragraph.create();
    const canonical = parsed.type.create(null, [paragraph]);
    return parsed.eq(canonical) && record.originalDoc.eq(canonical) &&
      document.eq(canonical);
  }


  // An editor opened on source-owned whitespace has no AST blocks, but Milkdown
  // supplies one canonical empty paragraph. Prove that exact opening state;
  // do not classify its whitespace as a zero-byte placeholder or discard it.
  function validateEmptyOpeningImageSource(record) {
    const source = record.originalSource;
    if (record.originalSourceMap !== null || typeof source !== "string" ||
        !/^[ \t\r\n]*$/.test(source) || /\r(?!\n)/.test(source) ||
        (source.includes("\r\n") && /(?<!\r)\n/.test(source))) return false;
    const original = record.originalDoc;
    const paragraph = original.type.schema.nodes.paragraph.create();
    if (!original.eq(original.type.create(null, [paragraph]))) return false;
    const emptyMap = map => map?.sourceLength === source.length &&
      Array.isArray(map.blocks) && map.blocks.length === 0 &&
      Array.isArray(map.inlineNodes) && map.inlineNodes.length === 0;
    if (!emptyMap(record.crepe.lilamayaSourceMap?.[0])) return false;
    let valid = false;
    record.crepe.editor.action(ctx => {
      const maps = record.crepe.lilamayaSourceMap, count = maps.length;
      const parsed = ctx.get(parserCtx)(source);
      valid = maps.length === count + 1 && emptyMap(maps[count]) &&
        !!parsed && parsed.eq(original);
    });
    return valid;
  }

  // Source-owned whitespace is not a zero-byte placeholder. Only an unchanged
  // terminal writing space after a supported protected block has this proof.
  function isWhitespaceStructuralImageSource(record, source, document, parsed, map) {
    const index = segments.indexOf(record.segment);
    if (index <= 0 || index !== segments.length - 1 || index !== record.segmentIndex ||
        !["introduction", "poetry", "invocation"].includes(segments[index - 1]?.type) ||
        typeof source !== "string" || !/^[ \t\r\n]+$/.test(source) ||
        /\r(?!\n)/.test(source) || (source.includes("\r\n") && /(?<!\r)\n/.test(source)) ||
        source !== record.originalSource || source !== record.segment.content ||
        record.originalSourceMap !== null || !parsed) return false;
    const emptyMap = value => value?.sourceLength === source.length &&
      Array.isArray(value.blocks) && value.blocks.length === 0 &&
      Array.isArray(value.inlineNodes) && value.inlineNodes.length === 0;
    if (!emptyMap(map) || !emptyMap(record.crepe.lilamayaSourceMap?.[0])) return false;
    const paragraph = parsed.type.schema.nodes.paragraph.create();
    const canonical = parsed.type.create(null, [paragraph]);
    return parsed.eq(canonical) && record.originalDoc.eq(canonical) && document.eq(canonical);
  }

  // This proof belongs only to one image operation. The opening-time anchors
  // remain untouched for normal source reconciliation and undo fidelity.
  function captureImageSourceBaseline(record) {
    const fail = message => { throw new Error("Cannot safely insert image: " + message + " Your draft was not changed."); };
    const zeroSource = record.segment.content === "" && record.originalSource === "";
    if (!zeroSource && !captureOriginalSourceMap([record.originalSourceMap], record.originalSource, record.originalDoc) &&
        !validateEmptyOpeningImageSource(record)) {
      fail("the opening source anchor could not be validated.");
    }
    const document = getEditorView(record).state.doc;
    const nodes = []; document.forEach(node => nodes.push(node));
    const original = []; record.originalDoc.forEach(node => original.push(node));
    if (isGeneratedTrailingCursor(nodes, record.crepe.lilamayaGeneratedTrailingParagraphs, original)) nodes.pop();
    const sourceDocument = document.copy(document.content.constructor.fromArray(nodes));
    let baseline;
    record.crepe.editor.action(ctx => {
      const parser = ctx.get(parserCtx), maps = record.crepe.lilamayaSourceMap;
      const count = maps.length;
      const parsed = parser(record.segment.content);
      // The collector must have run exactly once for this very parse.
      if (maps.length !== count + 1 || !parsed) fail("the current parse has no unique source map.");
      const emptyPlaceholder = isZeroByteImagePlaceholder(
        record, record.segment.content, document, parsed, maps[count]
      );
      if (emptyPlaceholder) {
        const map = Object.freeze({sourceLength: 0,
          blocks: Object.freeze([]), inlineNodes: Object.freeze([])});
        baseline = Object.freeze({record, source: "", document, parsed, map,
          parser, originalMap: record.originalSourceMap, emptyPlaceholder: true});
        return;
      }
      if (isWhitespaceStructuralImageSource(record, record.segment.content, document, parsed, maps[count])) {
        if (record === activeEditor) fail("the structural whitespace has no mapped image insertion boundary.");
        const map = Object.freeze({sourceLength: record.segment.content.length,
          blocks: Object.freeze([]), inlineNodes: Object.freeze([])});
        baseline = Object.freeze({record, source: record.segment.content, document,
          parsed, map, parser, originalMap: record.originalSourceMap, whitespaceStructural: true});
        return;
      }
      const map = captureOriginalSourceMap([maps[count]], record.segment.content, parsed);
      if (!map || parsed.childCount !== sourceDocument.childCount) fail("the current source map is invalid.");
      const generated = [];
      parsed.forEach((node, offset, index) => {
        const live = sourceDocument.child(index);
        if (!node.eq(live) && node.type.name === "heading" && live.type === node.type &&
            node.attrs.id === "" && typeof live.attrs.id === "string" && live.attrs.id &&
            ctx.get(headingIdGenerator.key)(live) === live.attrs.id) {
          // Only a source-absent, exact active-plugin-generated ID is allowed.
          // Every other attribute, child and mark must still compare exactly.
          node = node.type.create({...node.attrs, id: live.attrs.id}, node.content, node.marks);
        }
        generated.push(node);
      });
      if (!parsed.copy(parsed.content.constructor.fromArray(generated)).eq(sourceDocument)) {
        fail("the current Markdown and editor document do not correspond.");
      }
      baseline = Object.freeze({record, source: record.segment.content, document,
        parsed, map, parser, originalMap: record.originalSourceMap});
    });
    return baseline;
  }


  function createImageInsertionCallback() {
    if (!activeEditor || destroyed || rebuilding) {
      throw new Error("No active editor is available for image insertion.");
    }

    synchronizeSegments();
    const baselines = Object.freeze(editors.map(captureImageSourceBaseline));
    const record = activeEditor;
    const baseline = baselines.find(item => item.record === record);
    let savedSelection = null;

    record.crepe.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const selection = view.state.selection;

      savedSelection = Object.freeze({
        from: selection.from,
        to: selection.to,
        document: view.state.doc,
        source: record.segment.content,
        sourceMap: baseline.map,
        baseline,
        baselines,
        parser: ctx.get(parserCtx),
        segmentState: segments.map(segment => ({segment, content: segment.content})),
        introduction: introductionValue
      });
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
      !validatedLocalImagePath(markdown, imageSourcePrefix) ||
      typeof previewUrl !== "string" ||
      !previewUrl.startsWith("blob:")
    ) {
      throw new Error("Invalid image insertion request.");
    }

    const imagePath = validatedLocalImagePath(markdown, imageSourcePrefix);
    const segmentIndex = segments.indexOf(record.segment);


    if (segmentIndex < 0) {
      throw new Error("Active editor segment was not found.");
    }

    const fail = message => { throw new Error("Cannot safely insert image: " + message + " Your draft was not changed."); };
    if (!editors.includes(record) || imagePreviewUrls.has(imagePath)) {
      fail("the editor or image path is no longer available.");
    }
    if (savedSelection.from !== savedSelection.to || !Number.isInteger(savedSelection.from)) {
      fail("select a collapsed cursor at an unchanged paragraph end.");
    }
    if (introductionValue !== savedSelection.introduction ||
        savedSelection.segmentState.length !== segments.length ||
        savedSelection.segmentState.some((item,index) => item.segment !== segments[index] || item.content !== segments[index].content)) {
      fail("the document changed while image selection was open.");
    }
    // Rebuilding must never discard an edit made while the picker was open.
    if (savedSelection.baselines.length !== editors.length) fail("the editor set changed.");
    for (const baseline of savedSelection.baselines) {
      const item = baseline.record;
      if (!editors.includes(item) || item.segment.content !== baseline.source ||
          item.originalSourceMap !== baseline.originalMap ||
          !getEditorView(item).state.doc.eq(baseline.document)) {
        fail("a Markdown segment changed while image selection was open.");
      }
      item.crepe.editor.action(ctx => {
        if (ctx.get(parserCtx) !== baseline.parser) fail("the parser configuration changed.");
      });
      if (baseline.emptyPlaceholder) {
        if (!isZeroByteImagePlaceholder(item, baseline.source,
            getEditorView(item).state.doc, baseline.parsed, baseline.map)) {
          fail("the zero-byte placeholder proof is stale.");
        }
      } else if (baseline.whitespaceStructural) {
        let valid = false;
        item.crepe.editor.action(ctx => {
          const maps = item.crepe.lilamayaSourceMap, count = maps.length;
          const parsed = baseline.parser(baseline.source);
          valid = maps.length === count + 1 && !!parsed && parsed.eq(baseline.parsed) &&
            isWhitespaceStructuralImageSource(item, baseline.source,
              getEditorView(item).state.doc, parsed, maps[count]);
        });
        if (!valid) fail("the source-owned structural whitespace proof is stale.");
      } else if (!captureOriginalSourceMap([baseline.map], baseline.source, baseline.parsed)) {
        fail("the operation source map could not be revalidated.");
      }
    }
    const view = getEditorView(record);
    if (!view.state.doc.eq(savedSelection.document) ||
        view.state.selection.from !== savedSelection.from || view.state.selection.to !== savedSelection.to ||
        record.segment.content !== savedSelection.source || savedSelection.baseline.map !== savedSelection.sourceMap) {
      fail("the saved cursor or source map is stale.");
    }
    if (savedSelection.baseline.whitespaceStructural) {
      fail("structural whitespace has no mapped image insertion boundary.");
    }
    if (savedSelection.baseline.emptyPlaceholder) {
      fail("a zero-byte placeholder has no mapped insertion boundary.");
    }
    const source = savedSelection.baseline.source;
    const parsedDocument = savedSelection.baseline.parsed;
    const map = captureOriginalSourceMap([savedSelection.sourceMap], source, parsedDocument);
    if (!map) fail("the operation source map could not be validated.");
    const sourceBlocks = map.blocks.filter(block => block.depth === 1);
    let blockIndex = -1;
    parsedDocument.forEach((node,pos,index) => {
      if (node.type.name === "paragraph" && savedSelection.from === pos + node.nodeSize - 1) blockIndex = index;
    });
    if (blockIndex < 0 || sourceBlocks[blockIndex]?.type !== "paragraph") {
      fail("only proven top-level paragraph-end boundaries are supported.");
    }
    const offset = sourceBlocks[blockIndex].end;
    const endings = new Set(source.match(/\r\n|\r|\n/g) || []);
    if (endings.size === 0) {
      // An earlier image insertion can leave this paragraph in its own segment.
      // Only an existing adjacent blank-line boundary can establish its EOL.
      const boundary = segments[segmentIndex + 1]?.content.match(/^(\r\n|\n)\1/);
      if (boundary) endings.add(boundary[1]);
    }
    if (endings.size !== 1 || endings.has("\r")) fail("the local line-ending style is ambiguous.");
    const eol = [...endings][0];
    const left = source.slice(0,offset), right = source.slice(offset);
    const imageSource = eol + eol + markdown;
    const candidateSource = left + imageSource + right;
    const segmented = parseHugoDocument(candidateSource);
    if (segmented.frontmatter !== "" || segmented.segments.length !== 1 ||
        segmented.segments[0].type !== "markdown" || segmented.segments[0].content !== candidateSource) {
      fail("the image would create or cross a protected shortcode boundary.");
    }
    // Compare exact parser documents, without serializing any source-backed node
    // or ignoring attributes. Live generated heading IDs need no normalization:
    // the unchanged source is parsed under the same parser on both sides.
    record.crepe.editor.action(ctx => {
      const parser = ctx.get(parserCtx);
      if (parser !== savedSelection.parser) fail("the parser configuration changed.");
      const before = parser(source), image = parser(markdown), after = parser(candidateSource);
      if (!before || !before.eq(parsedDocument) ||
          !image || image.childCount !== 1 || image.firstChild.type.name !== "paragraph" ||
          image.firstChild.childCount !== 1 || image.firstChild.firstChild.type.name !== "image" ||
          image.firstChild.firstChild.attrs.src !== imagePath) {
        fail("the insertion has no unambiguous parser correspondence.");
      }
      const nodes = []; before.forEach(node => nodes.push(node));
      nodes.splice(blockIndex + 1,0,image.firstChild);
      const expected = ctx.get(schemaCtx).nodes.doc.create(null,nodes);
      if (!after || !after.eq(expected)) fail("the proposed Markdown changes the intended document structure.");
    });
    // All source/position/structure checks completed before any mutation.
    const previousSegments = [...segments];
    const replacement = [
      {type:"markdown",content:left},
      {type:"markdown",content:imageSource},
      {type:"markdown",content:right}
    ];
    segments.splice(segmentIndex,1,...replacement);
    imagePreviewUrls.set(imagePath,previewUrl);
    try {
      await rebuildSegments(segmentIndex + 2);
    } catch (error) {
      // Render failure is not permission to discard the original source.
      segments.splice(0,segments.length,...previousSegments);
      imagePreviewUrls.delete(imagePath);
      try {
        await rebuildSegments(segmentIndex);
        const restored = editors.find(item => item.segment === record.segment);
        if (restored) {
          const restoredView = getEditorView(restored);
          restoredView.dispatch(restoredView.state.tr.setSelection(
            TextSelection.create(restoredView.state.doc,savedSelection.from,savedSelection.to)
          ));
        }
      } catch (restoreError) {
        const failure = new Error("Image rendering and editor restoration failed; preserve the retained source snapshot.");
        failure.sourceSnapshot = previousSegments.map(segment => ({type:segment.type,content:segment.content}));
        failure.cause = restoreError;
        throw failure;
      }
      throw new Error("Image rendering failed. The original source was restored.",{cause:error});
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

  createButton("•", "Bulleted list", wrapInBulletListCommand);
  createButton("1.", "Numbered list", wrapInOrderedListCommand);

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


  // Existing Hugo shortcode dropdown; insertion is source-slice validated.

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

  shortcodeSelect.title = "Insert at a top-level paragraph end or a validated empty body.";
  updateShortcodeChoices();
  shortcodeSelect.addEventListener("pointerdown", () => {
    reconcileFocusedEditor(isEditorAction(document.activeElement));
  }, true);
  shortcodeSelect.addEventListener("change", async () => {
    const kind=shortcodeSelect.value;
    if(!kind) return;
    shortcodeSelect.disabled=true;
    try { await insertShortcode(kind); }
    catch(error) { console.error("Shortcode insertion failed:",error); window.alert(error.message); }
    finally { shortcodeSelect.value=""; shortcodeSelect.disabled=false; updateShortcodeChoices(); }
  });


  toolbar.appendChild(shortcodeSelect);




  // Initial document rendering.
  // An entirely empty document still needs one editable Markdown paragraph.
  const hasNonEmptyMarkdown = segments.some(
    segment => segment.type === "markdown" && segment.content.trim() !== ""
  );
  const emptyBodyIndex = emptyProtectedBodyIndex();
  let mountedEmptyMarkdown = false;

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];

    if (segment.type !== "markdown") {
      content.appendChild(
        renderProtectedSegment(segment)
      );

      continue;
    }

    if (segment.content.trim() === "") {
      if (index !== emptyBodyIndex && (hasNonEmptyMarkdown || mountedEmptyMarkdown || emptyBodyIndex >= 0)) {
        continue;
      }

      mountedEmptyMarkdown = true;
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
    record.originalSource = segment.content;
    record.originalDoc = sourceBackedBaselineDocument(
      getEditorView(record).state.doc,
      record.crepe.lilamayaSourceMap?.[0],
      record.crepe.lilamayaGeneratedTrailingParagraphs
    );
    record.originalSourceMap = captureOriginalSourceMap(
      record.crepe.lilamayaSourceMap,
      record.originalSource,
      record.originalDoc
    );
    record.generatedHeadingProvenance = captureGeneratedHeadingProvenance(record);
    diagnoseSingleBlockSerialization(record);
    console.group("LILAMAYA SOURCE FIDELITY DIAGNOSTIC");

    console.log(
      "REMARK AST SOURCE MAP:",
      JSON.stringify(record.crepe.lilamayaSourceMap, null, 2)
    );

    console.log(
      "PROSEMIRROR DOCUMENT:",
      JSON.stringify(
        inspectProseMirrorStructure(record.originalDoc),
        null,
        2
      )
    );

    console.groupEnd();


        // Keep the original ProseMirror document as a fidelity reference.
        // If the editor returns to this exact state, preserve the original Markdown.

    resolveImagePreviewUrls(editorRoot, imageBaseUrl, imagePreviewUrls);

    trackEditorFocus(record);

    editorRoot.addEventListener("input", () => {
      record.dirty = true;
      if (searchInput.value) refreshSearch(false);
    });

    editors.push(record);

    reconcileFocusedEditor();
  }


  return {

    captureDraftSnapshot() {
      if (destroyed) throw new Error("The editor is unavailable; keep the page open.");
      return {
        format: "lilamaya-editor-buffer-v1",
        frontmatter: documentModel.frontmatter,
        introduction: introductionValue,
        imagePaths: [...imagePreviewUrls.keys()],
        segments: segments.map(segment => {
          const record = editors.find(item => item.segment === segment);
          const textarea = protectedTextareas.get(segment);
          return {type:segment.type, source:segment.content,
            ...(record ? {originalSource:record.originalSource,
              document:getEditorView(record).state.doc.toJSON()} : {}),
            ...(textarea ? {protectedText:textarea.value} : {})};
        })
      };
    },

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

    diagnoseChangedBlocks() {
      for (const record of editors) {
        diagnoseChangedBlocks(record);
      }
    },

    diagnoseCurrentBlockSerialization() {
      for (const record of editors) {
        diagnoseCurrentBlockSerialization(record);
      }
    },

    diagnoseSourceReplacement() {
      for (const record of editors) {
        diagnoseSourceReplacement(record);
      }
    },

    diagnoseProseMirrorInlineFormatting() {
      for (const record of editors) {
        diagnoseProseMirrorInlineFormatting(record);
      }
    },

    inspectInlineSourceMap() {
      for (const record of editors) {
        const maps = record.crepe.lilamayaSourceMap || [];

        console.group("LILAMAYA FORMATTED INLINE NODES");

        console.log("Segment:", record.segment.title || record.segment.type);
        console.log("Source length:", record.segment.content.length);
        console.log("Original source (exact):", JSON.stringify(record.originalSource));
        console.log("Original source is whitespace-only:", /^\\s*$/.test(record.originalSource));

        for (const map of maps) {
          const formattedNodes = (map.inlineNodes || [])
            .filter(node =>
              node.type !== "text" ||
              node.parentInline?.some(parent => parent.type === "emphasis")
            );

          console.log("Total inline nodes:", (map.inlineNodes || []).length);
          console.log("Formatted nodes:", formattedNodes.length);
          console.table(formattedNodes);
        }

        console.groupEnd();
      }
    },

    diagnoseParserHistory() {
      const testMarkdown =
        "Lilamaya parser diagnostic paragraph.\\n\\nSecond paragraph.";

      for (const record of editors) {
        const maps = record.crepe.lilamayaSourceMap || [];
        const originalMapBefore = JSON.stringify(
          record.originalSourceMap
        );
        const countBefore = maps.length;

        let parsedDocument = null;

        record.crepe.editor.action(ctx => {
          const parser = ctx.get(parserCtx);
          parsedDocument = parser(testMarkdown);
        });

        const countAfter = maps.length;
        const originalMapAfter = JSON.stringify(
          record.originalSourceMap
        );

        console.group(
          "LILAMAYA PARSER HISTORY DIAGNOSTIC"
        );

        console.log("Segment:", record.segment.title || record.segment.type);
        console.log("Entries before:", countBefore);
        console.log("Entries after:", countAfter);
        console.log("New entry appended:", countAfter === countBefore + 1);
        console.log("Parsed document:", parsedDocument);
        console.log(
          "Original baseline unchanged:",
          originalMapBefore === originalMapAfter
        );
        console.log(
          "Original baseline frozen:",
          Object.isFrozen(record.originalSourceMap)
        );

        console.groupEnd();
      }
    },

    get editor() {
      return activeEditor?.crepe.editor || null;
    }

  };
}
