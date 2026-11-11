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
  schemaCtx,
  serializerCtx
} from "@milkdown/kit/core";

import {Plugin, TextSelection} from "@milkdown/kit/prose/state";
import {$prose, $remark} from "@milkdown/kit/utils";

import {
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
  crepe.editor.use(createTransactionDiagnosticExtension());

  const sourceMap = [];
  crepe.editor.use(createSourceMapDiagnostic(sourceMap));
  crepe.lilamayaSourceMap = sourceMap;

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
          serializedDocument = serializer(currentDocument);
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

      // Ignore Milkdown's additional empty trailing paragraph only
      // when it is the sole additional final block.
      if (currentBlocks.length === originalBlocks.length + 1) {
        const lastBlock = currentBlocks[currentBlocks.length - 1];

        if (
          lastBlock.type.name === "paragraph" &&
          lastBlock.content.size === 0
        ) {
          currentBlocks.pop();
        }
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

            serialized = serializer(wrapper);
          });

          if (typeof serialized !== "string") {
            throw new Error(
              "Cannot safely synchronize: structural region serialization failed."
            );
          }

          return serialized;
        });

        const replacements = buildSeparatorAwareReplacements(
          originalSource,
          sourceBlocks,
          plan,
          serializedRegions
        );

        record.segment.content = applySourceReplacements(
          originalSource,
          replacements
        );

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
        record.originalSource = segment.content;
        record.originalDoc = getEditorView(record).state.doc;
        record.originalSourceMap = captureOriginalSourceMap(
          record.crepe.lilamayaSourceMap,
          record.originalSource,
          record.originalDoc
        );
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
  // An entirely empty document still needs one editable Markdown paragraph.
  const hasNonEmptyMarkdown = segments.some(
    segment => segment.type === "markdown" && segment.content.trim() !== ""
  );
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
      if (hasNonEmptyMarkdown || mountedEmptyMarkdown) {
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
    record.originalDoc = getEditorView(record).state.doc;
    record.originalSourceMap = captureOriginalSourceMap(
      record.crepe.lilamayaSourceMap,
      record.originalSource,
      record.originalDoc
    );
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
