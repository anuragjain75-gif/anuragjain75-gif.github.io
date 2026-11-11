export function applySourceReplacements(originalSource, replacements) {
  if (typeof originalSource !== "string") {
    throw new TypeError("Original source must be a string.");
  }

  if (!Array.isArray(replacements)) {
    throw new TypeError("Replacements must be an array.");
  }

  const ordered = [...replacements].sort(
    (a, b) => a.start - b.start
  );

  for (let index = 0; index < ordered.length; index++) {
    const item = ordered[index];

    if (
      !item ||
      !Number.isInteger(item.start) ||
      !Number.isInteger(item.end) ||
      typeof item.replacement !== "string" ||
      item.start < 0 ||
      item.end <= item.start ||
      item.end > originalSource.length
    ) {
      throw new Error("Invalid source replacement range.");
    }

    if (
      index > 0 &&
      item.start < ordered[index - 1].end
    ) {
      throw new Error("Source replacement ranges overlap.");
    }
  }

  let result = originalSource;

  for (const item of [...ordered].reverse()) {
    result =
      result.slice(0, item.start) +
      item.replacement +
      result.slice(item.end);
  }

  return result;
}

/**
 * Identify unchanged blocks and the regions between them.
 *
 * Each block must have:
 *   key: a stable string identifying its exact original/current content
 *
 * The planner does not serialize Markdown or modify source text.
 * Ambiguous repeated matches and reordered anchors are rejected.
 */
export function planBlockReconciliation(originalBlocks, currentBlocks) {
  if (!Array.isArray(originalBlocks) || !Array.isArray(currentBlocks)) {
    throw new TypeError("Original and current blocks must be arrays.");
  }

  function validateBlocks(blocks, label) {
    for (let index = 0; index < blocks.length; index++) {
      if (
        !blocks[index] ||
        typeof blocks[index].key !== "string" ||
        blocks[index].key.length === 0
      ) {
        throw new Error(
          `${label} block ${index} has no valid identity key.`
        );
      }
    }
  }

  validateBlocks(originalBlocks, "Original");
  validateBlocks(currentBlocks, "Current");

  const originalPositions = new Map();
  const currentPositions = new Map();

  function collectPositions(blocks, positions) {
    blocks.forEach((block, index) => {
      const indexes = positions.get(block.key) || [];
      indexes.push(index);
      positions.set(block.key, indexes);
    });
  }

  collectPositions(originalBlocks, originalPositions);
  collectPositions(currentBlocks, currentPositions);

  // A repeated identity cannot safely establish which occurrence survived.
  for (const [key, originalIndexes] of originalPositions) {
    const currentIndexes = currentPositions.get(key);

    if (
      currentIndexes &&
      (originalIndexes.length > 1 || currentIndexes.length > 1)
    ) {
      throw new Error(
        "Ambiguous repeated block identity; refusing unsafe reconciliation."
      );
    }
  }

  const anchors = [];

  for (const [key, originalIndexes] of originalPositions) {
    const currentIndexes = currentPositions.get(key);

    if (
      originalIndexes.length === 1 &&
      currentIndexes &&
      currentIndexes.length === 1
    ) {
      anchors.push({
        key,
        originalIndex: originalIndexes[0],
        currentIndex: currentIndexes[0]
      });
    }
  }

  anchors.sort((a, b) => a.originalIndex - b.originalIndex);

  // Reordered anchors make the correspondence unsafe for this algorithm.
  for (let index = 1; index < anchors.length; index++) {
    if (anchors[index].currentIndex <= anchors[index - 1].currentIndex) {
      throw new Error(
        "Block order changed or anchor correspondence is ambiguous."
      );
    }
  }

  const regions = [];
  let originalCursor = 0;
  let currentCursor = 0;

  function addRegion(originalEnd, currentEnd) {
    if (
      originalCursor !== originalEnd ||
      currentCursor !== currentEnd
    ) {
      regions.push({
        originalStart: originalCursor,
        originalEnd,
        currentStart: currentCursor,
        currentEnd
      });
    }
  }

  for (const anchor of anchors) {
    addRegion(anchor.originalIndex, anchor.currentIndex);

    originalCursor = anchor.originalIndex + 1;
    currentCursor = anchor.currentIndex + 1;
  }

  addRegion(originalBlocks.length, currentBlocks.length);

  return {
    anchors,
    regions
  };
}


/**
 * Build source replacements for changed regions bounded by original blocks.
 *
 * This conservative version supports only non-empty replacements of
 * existing source blocks. Insertions and deletions are rejected.
 */
export function buildSourceRegionReplacements(
  originalSource,
  sourceBlocks,
  plan,
  serializedRegions
) {
  if (typeof originalSource !== "string") {
    throw new TypeError("Original source must be a string.");
  }
  if (!Array.isArray(sourceBlocks)) {
    throw new TypeError("Source blocks must be an array.");
  }
  if (!plan || !Array.isArray(plan.regions)) {
    throw new TypeError("A valid reconciliation plan is required.");
  }
  if (!Array.isArray(serializedRegions)) {
    throw new TypeError("Serialized regions must be an array.");
  }
  if (serializedRegions.length !== plan.regions.length) {
    throw new Error("Serialized region count does not match the plan.");
  }

  let previousBlockEnd = 0;
  for (const block of sourceBlocks) {
    if (
      !block ||
      !Number.isInteger(block.start) ||
      !Number.isInteger(block.end) ||
      block.start < previousBlockEnd ||
      block.end <= block.start ||
      block.end > originalSource.length
    ) {
      throw new Error("Invalid or overlapping original source block offsets.");
    }
    previousBlockEnd = block.end;
  }

  const replacements = [];
  let previousOriginalRegionEnd = 0;
  let previousCurrentRegionEnd = 0;

  for (let index = 0; index < plan.regions.length; index++) {
    const region = plan.regions[index];
    const serialized = serializedRegions[index];

    if (typeof serialized !== "string" || serialized.length === 0) {
      throw new Error("Empty or invalid serialization; deletions are not supported.");
    }

    if (
      !region ||
      !Number.isInteger(region.originalStart) ||
      !Number.isInteger(region.originalEnd) ||
      !Number.isInteger(region.currentStart) ||
      !Number.isInteger(region.currentEnd) ||
      region.originalStart < previousOriginalRegionEnd ||
      region.originalEnd <= region.originalStart ||
      region.originalEnd > sourceBlocks.length ||
      region.currentStart < previousCurrentRegionEnd ||
      region.currentEnd <= region.currentStart
    ) {
      throw new Error("Invalid region boundaries; insertions and deletions are not supported.");
    }

    const firstBlock = sourceBlocks[region.originalStart];
    const lastBlock = sourceBlocks[region.originalEnd - 1];
    const start = firstBlock.start;
    const end = lastBlock.end;

    if (end <= start || end > originalSource.length) {
      throw new Error("Invalid changed-region source boundaries.");
    }

    replacements.push({ start, end, replacement: serialized });
    previousOriginalRegionEnd = region.originalEnd;
    previousCurrentRegionEnd = region.currentEnd;
  }

  const ordered = [...replacements].sort((a, b) => a.start - b.start);
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index].start < ordered[index - 1].end) {
      throw new Error("Changed-region source ranges overlap.");
    }
  }

  return replacements;
}


/**
 * Reconcile actual ProseMirror nodes using their native equality method.
 *
 * Only nodes with one unambiguous exact match on both sides become anchors.
 * Repeated equal nodes and reordered anchors are rejected.
 */
export function planNodeReconciliation(originalNodes, currentNodes) {
  if (!Array.isArray(originalNodes) || !Array.isArray(currentNodes)) {
    throw new TypeError("Original and current nodes must be arrays.");
  }

  function validateNodes(nodes, label) {
    nodes.forEach((node, index) => {
      if (!node || typeof node.eq !== "function") {
        throw new Error(
          `${label} node ${index} does not provide ProseMirror equality.`
        );
      }
    });
  }

  validateNodes(originalNodes, "Original");
  validateNodes(currentNodes, "Current");

  const originalMatches = originalNodes.map(originalNode => {
    const matches = [];
    currentNodes.forEach((currentNode, index) => {
      if (originalNode.eq(currentNode)) matches.push(index);
    });
    return matches;
  });

  const currentMatches = currentNodes.map(currentNode => {
    const matches = [];
    originalNodes.forEach((originalNode, index) => {
      if (originalNode.eq(currentNode)) matches.push(index);
    });
    return matches;
  });

  for (let index = 0; index < originalMatches.length; index++) {
    if (originalMatches[index].length > 1) {
      throw new Error(
        "Ambiguous repeated ProseMirror node; refusing unsafe reconciliation."
      );
    }
  }

  for (let index = 0; index < currentMatches.length; index++) {
    if (currentMatches[index].length > 1) {
      throw new Error(
        "Ambiguous repeated ProseMirror node; refusing unsafe reconciliation."
      );
    }
  }

  const anchors = [];

  originalMatches.forEach((matches, originalIndex) => {
    if (matches.length === 1) {
      const currentIndex = matches[0];

      if (currentMatches[currentIndex].length === 1) {
        anchors.push({ originalIndex, currentIndex });
      }
    }
  });

  anchors.sort((a, b) => a.originalIndex - b.originalIndex);

  for (let index = 1; index < anchors.length; index++) {
    if (anchors[index].currentIndex <= anchors[index - 1].currentIndex) {
      throw new Error(
        "Block order changed or anchor correspondence is ambiguous."
      );
    }
  }

  const regions = [];
  let originalCursor = 0;
  let currentCursor = 0;

  function addRegion(originalEnd, currentEnd) {
    if (
      originalCursor !== originalEnd ||
      currentCursor !== currentEnd
    ) {
      regions.push({
        originalStart: originalCursor,
        originalEnd,
        currentStart: currentCursor,
        currentEnd
      });
    }
  }

  for (const anchor of anchors) {
    addRegion(anchor.originalIndex, anchor.currentIndex);
    originalCursor = anchor.originalIndex + 1;
    currentCursor = anchor.currentIndex + 1;
  }

  addRegion(originalNodes.length, currentNodes.length);

  return { anchors, regions };
}


/**
 * Build replacements for structural changes between two unchanged anchors.
 *
 * Initial scope: ordinary blocks separated by identical whitespace gaps.
 * Boundary insertions and non-uniform separators are deliberately rejected.
 */
export function buildSeparatorAwareReplacements(
  originalSource,
  sourceBlocks,
  plan,
  serializedRegions
) {
  if (typeof originalSource !== "string") {
    throw new TypeError("Original source must be a string.");
  }
  if (!Array.isArray(sourceBlocks) || !Array.isArray(serializedRegions)) {
    throw new TypeError("Source blocks and serialized regions must be arrays.");
  }
  if (!plan || !Array.isArray(plan.regions) || !Array.isArray(plan.anchors)) {
    throw new TypeError("A valid reconciliation plan is required.");
  }
  if (serializedRegions.length !== plan.regions.length) {
    throw new Error("Serialized region count does not match the plan.");
  }

  let previousEnd = 0;
  for (const block of sourceBlocks) {
    if (
      !block ||
      !Number.isInteger(block.start) ||
      !Number.isInteger(block.end) ||
      block.start < previousEnd ||
      block.end <= block.start ||
      block.end > originalSource.length
    ) {
      throw new Error("Invalid or overlapping original source block offsets.");
    }
    previousEnd = block.end;
  }

  for (const anchor of plan.anchors) {
    if (
      !anchor ||
      !Number.isInteger(anchor.originalIndex) ||
      !Number.isInteger(anchor.currentIndex) ||
      anchor.originalIndex < 0 ||
      anchor.originalIndex >= sourceBlocks.length
    ) {
      throw new Error("Invalid reconciliation anchor.");
    }
  }

  const replacements = [];
  let previousOriginalEnd = 0;
  let previousCurrentEnd = 0;

  for (let index = 0; index < plan.regions.length; index++) {
    const region = plan.regions[index];
    const serialized = serializedRegions[index];

    if (typeof serialized !== "string") {
      throw new Error("Serialized region must be a string.");
    }

    if (
      !region ||
      !Number.isInteger(region.originalStart) ||
      !Number.isInteger(region.originalEnd) ||
      !Number.isInteger(region.currentStart) ||
      !Number.isInteger(region.currentEnd) ||
      region.originalStart < previousOriginalEnd ||
      region.originalEnd < region.originalStart ||
      region.originalEnd > sourceBlocks.length ||
      region.currentStart < previousCurrentEnd ||
      region.currentEnd < region.currentStart
    ) {
      throw new Error("Invalid structural region boundaries.");
    }

    const previousAnchor = [...plan.anchors]
      .reverse()
      .find(anchor => anchor.originalIndex < region.originalStart);

    const nextAnchor = plan.anchors.find(
      anchor => anchor.originalIndex >= region.originalEnd
    );

    if (!previousAnchor || !nextAnchor) {
      throw new Error(
        "Structural changes at the beginning or end are not supported yet."
      );
    }

    const leftBlock = sourceBlocks[previousAnchor.originalIndex];
    const rightBlock = sourceBlocks[nextAnchor.originalIndex];
    const start = leftBlock.end;
    const end = rightBlock.start;

    if (end <= start) {
      throw new Error("Invalid source interval between unchanged anchors.");
    }

    const originalCount = region.originalEnd - region.originalStart;
    const currentCount = region.currentEnd - region.currentStart;

    if (originalCount === 0) {
      const separator = originalSource.slice(start, end);

      if (!separator || !/^\s+$/.test(separator) || !serialized.trim()) {
        throw new Error(
          "Insertion requires a non-empty whitespace separator and content."
        );
      }

      // Remove serializer-generated trailing line breaks.
      // The original source separator is preserved on both sides.
      const cleanSerialized = serialized.replace(/(?:\r?\n)+$/, "");

      if (!cleanSerialized.trim()) {
        throw new Error("Insertion serialization contains no content.");
      }

      replacements.push({
        start,
        end,
        replacement: separator + cleanSerialized + separator
      });

    } else {
      const firstBlock = sourceBlocks[region.originalStart];
      const lastBlock = sourceBlocks[region.originalEnd - 1];
      const prefix = originalSource.slice(start, firstBlock.start);
      const suffix = originalSource.slice(lastBlock.end, end);

      if (
        !prefix ||
        !suffix ||
        !/^\s+$/.test(prefix) ||
        !/^\s+$/.test(suffix) ||
        prefix !== suffix
      ) {
        throw new Error(
          "Cannot safely reconcile this region: surrounding separators differ or are not whitespace."
        );
      }

      if (currentCount === 0) {
        if (serialized.length !== 0) {
          throw new Error("Deleted region must have an empty serialization.");
        }

        replacements.push({ start, end, replacement: prefix });

      } else {
        if (!serialized.trim()) {
          throw new Error(
            "A non-empty current region requires serialized content."
          );
        }

        replacements.push({
          start,
          end,
          replacement: prefix + serialized + suffix
        });
      }
    }

    previousOriginalEnd = region.originalEnd;
    previousCurrentEnd = region.currentEnd;
  }

  return replacements;
}
