import {Plugin, PluginKey} from "@milkdown/kit/prose/state";
import {Decoration, DecorationSet} from "@milkdown/kit/prose/view";
import {$prose} from "@milkdown/kit/utils";

/*
 * Find matches across every text block in a ProseMirror document.
 *
 * Text nodes within a block are joined before searching. This allows
 * a match to cross formatting boundaries such as bold and italic.
 *
 * Positions returned are absolute ProseMirror document positions.
 */
export function findLilamayaMatches(doc, query) {
  const needle = String(query || "").toLocaleLowerCase();

  if (!needle) {
    return [];
  }

  const matches = [];

  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) {
      return;
    }

    let blockText = "";

    block.descendants(child => {
      if (child.isText && child.text) {
        blockText += child.text;
      }
    });

    const searchableText = blockText.toLocaleLowerCase();
    let searchFrom = 0;

    while (searchFrom <= searchableText.length - needle.length) {
      const foundAt = searchableText.indexOf(needle, searchFrom);

      if (foundAt === -1) {
        break;
      }

      matches.push({
        from: blockPos + 1 + foundAt,
        to: blockPos + 1 + foundAt + needle.length
      });

      // Find and Replace uses conventional non-overlapping matches.
      searchFrom = foundAt + needle.length;
    }
  });

  return matches;
}


function buildSearchDecorations(doc, query, activeIndex) {
  if (!query) {
    return DecorationSet.empty;
  }

  const decorations = [];
  let matchIndex = 0;

  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) {
      return;
    }

    let blockText = "";
    const spans = [];

    block.descendants((child, childPos) => {
      if (!child.isText || !child.text) {
        return;
      }

      spans.push({
        start: childPos,
        end: childPos + child.nodeSize
      });

      blockText += child.text;
    });

    const needle = String(query).toLocaleLowerCase();
    const searchableText = blockText.toLocaleLowerCase();
    let searchFrom = 0;

    while (searchFrom <= searchableText.length - needle.length) {
      const foundAt = searchableText.indexOf(needle, searchFrom);

      if (foundAt === -1) {
        break;
      }

      const matchEnd = foundAt + needle.length;
      const isActive = matchIndex === activeIndex;

      for (const span of spans) {
        const overlapStart = Math.max(foundAt, span.start);
        const overlapEnd = Math.min(matchEnd, span.end);

        if (overlapStart >= overlapEnd) {
          continue;
        }

        decorations.push(
          Decoration.inline(
            blockPos + 1 + overlapStart,
            blockPos + 1 + overlapEnd,
            {
              class: isActive
                ? "lilamaya-search-match lilamaya-search-match-active"
                : "lilamaya-search-match"
            }
          )
        );
      }

      matchIndex++;
      searchFrom = foundAt + needle.length;
    }
  });

  return DecorationSet.create(doc, decorations);
}


export function createLilamayaSearchExtension() {
  const key = new PluginKey("lilamaya-search");

  const plugin = new Plugin({
    key,

    state: {
      init() {
        return {
          query: "",
          activeIndex: -1,
          decorations: DecorationSet.empty
        };
      },

      apply(transaction, previous, oldState, newState) {
        const meta = transaction.getMeta(key);

        const query =
          meta && Object.prototype.hasOwnProperty.call(meta, "query")
            ? meta.query
            : previous.query;

        const activeIndex =
          meta && Object.prototype.hasOwnProperty.call(meta, "activeIndex")
            ? meta.activeIndex
            : previous.activeIndex;

        if (!transaction.docChanged && !meta) {
          return previous;
        }

        return {
          query,
          activeIndex,
          decorations: buildSearchDecorations(
            newState.doc,
            query,
            activeIndex
          )
        };
      }
    },

    props: {
      decorations(state) {
        return key.getState(state)?.decorations ?? null;
      }
    }
  });

  return {
    key,
    extension: $prose(() => plugin)
  };
}


export function updateLilamayaSearch(
  view,
  key,
  query,
  activeIndex = -1
) {
  if (!view || !key) {
    return;
  }

  view.dispatch(
    view.state.tr.setMeta(key, {
      query: String(query || ""),
      activeIndex
    })
  );
}
