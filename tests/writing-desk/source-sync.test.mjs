
import test from "node:test";
import assert from "node:assert/strict";
import { Schema } from "@milkdown/kit/prose/model";

import {
  applySourceReplacements,
  buildSourceRegionReplacements,
  planNodeReconciliation,
  buildSeparatorAwareReplacements
} from "../../assets/js/lilamaya-source-sync.js";


test("replaces one changed block", () => {
  const source = "First paragraph.\n\nSecond paragraph.";

  const start = source.indexOf("Second paragraph.");

  const result = applySourceReplacements(source, [
    {
      start,
      end: start + "Second paragraph.".length,
      replacement: "Revised paragraph."
    }
  ]);

  assert.equal(
    result,
    "First paragraph.\n\nRevised paragraph."
  );
});


test("replaces multiple blocks supplied in arbitrary order", () => {
  const source =
    "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";

  const firstStart = source.indexOf("First paragraph.");
  const thirdStart = source.indexOf("Third paragraph.");

  const result = applySourceReplacements(source, [
    {
      start: thirdStart,
      end: thirdStart + "Third paragraph.".length,
      replacement: "Third revised."
    },
    {
      start: firstStart,
      end: firstStart + "First paragraph.".length,
      replacement: "First revised."
    }
  ]);

  assert.equal(
    result,
    "First revised.\n\nSecond paragraph.\n\nThird revised."
  );
});


test("preserves the source when there are no replacements", () => {
  const source = "Original Markdown.\n\nAnother paragraph.";

  assert.equal(
    applySourceReplacements(source, []),
    source
  );
});


test("rejects overlapping replacement ranges", () => {
  const source = "ABCDEFGHIJ";

  assert.throws(
    () => applySourceReplacements(source, [
      { start: 1, end: 5, replacement: "First" },
      { start: 4, end: 8, replacement: "Second" }
    ]),
    /overlap/
  );
});


test("rejects negative source offsets", () => {
  assert.throws(
    () => applySourceReplacements("ABCDEFGHIJ", [
      { start: -1, end: 3, replacement: "X" }
    ]),
    /Invalid source replacement range/
  );
});


test("rejects offsets beyond the original source", () => {
  assert.throws(
    () => applySourceReplacements("ABCDE", [
      { start: 2, end: 8, replacement: "X" }
    ]),
    /Invalid source replacement range/
  );
});


test("rejects empty or reversed source ranges", () => {
  assert.throws(
    () => applySourceReplacements("ABCDE", [
      { start: 3, end: 3, replacement: "X" }
    ]),
    /Invalid source replacement range/
  );

  assert.throws(
    () => applySourceReplacements("ABCDE", [
      { start: 4, end: 2, replacement: "X" }
    ]),
    /Invalid source replacement range/
  );
});


test("rejects non-string original source", () => {
  assert.throws(
    () => applySourceReplacements(null, []),
    /Original source must be a string/
  );
});


test("rejects non-array replacements", () => {
  assert.throws(
    () => applySourceReplacements("ABCDE", null),
    /Replacements must be an array/
  );
});


test("does not mutate the original source or replacements", () => {
  const source = "First paragraph.\n\nSecond paragraph.";

  const start = source.indexOf("Second paragraph.");

  const replacements = [
    {
      start,
      end: start + "Second paragraph.".length,
      replacement: "Revised paragraph."
    }
  ];

  const originalReplacements = structuredClone(replacements);

  applySourceReplacements(source, replacements);

  assert.equal(source, "First paragraph.\n\nSecond paragraph.");

  assert.deepEqual(
    replacements,
    originalReplacements
  );
});


test("preserves Unicode and Sanskrit diacritics around replacements", () => {
  const source =
    "प्रथमः परिच्छेदः।\n\n" +
    "Ātman is Brahman — आत्मा ब्रह्म।\n\n" +
    "अन्तिमः परिच्छेदः।";

  const target = "Ātman is Brahman — आत्मा ब्रह्म।";
  const start = source.indexOf(target);

  const result = applySourceReplacements(source, [
    {
      start,
      end: start + target.length,
      replacement: "Brahman alone is real — ब्रह्म एव सत्यम्।"
    }
  ]);

  assert.equal(
    result,
    "प्रथमः परिच्छेदः।\n\n" +
    "Brahman alone is real — ब्रह्म एव सत्यम्।\n\n" +
    "अन्तिमः परिच्छेदः।"
  );
});


test("preserves emoji and supplementary Unicode characters", () => {
  const source =
    "🌳 A tree in the garden.\n\n" +
    "The original paragraph.\n\n" +
    "A quiet evening. 🌙";

  const target = "The original paragraph.";
  const start = source.indexOf(target);

  const result = applySourceReplacements(source, [
    {
      start,
      end: start + target.length,
      replacement: "The revised paragraph."
    }
  ]);

  assert.equal(
    result,
    "🌳 A tree in the garden.\n\n" +
    "The revised paragraph.\n\n" +
    "A quiet evening. 🌙"
  );
});


test("preserves CRLF line endings outside replaced ranges", () => {
  const source =
    "# A Title\r\n" +
    "\r\n" +
    "First paragraph.\r\n" +
    "\r\n" +
    "Second paragraph.\r\n" +
    "\r\n" +
    "Final paragraph.";

  const target = "Second paragraph.";
  const start = source.indexOf(target);

  const result = applySourceReplacements(source, [
    {
      start,
      end: start + target.length,
      replacement: "Revised second paragraph."
    }
  ]);

  assert.equal(
    result,
    "# A Title\r\n" +
    "\r\n" +
    "First paragraph.\r\n" +
    "\r\n" +
    "Revised second paragraph.\r\n" +
    "\r\n" +
    "Final paragraph."
  );

  assert.equal(result.includes("\n"), true);
  assert.equal(result.replace(/\r\n/g, "").includes("\n"), false);
});


test("accepts adjacent non-overlapping replacement ranges", () => {
  const source = "ABCDEF";

  const result = applySourceReplacements(source, [
    { start: 3, end: 6, replacement: "XYZ" },
    { start: 0, end: 3, replacement: "123" }
  ]);

  assert.equal(result, "123XYZ");
});


test("allows replacement with an empty string", () => {
  const source =
    "First paragraph.\n\n" +
    "Paragraph to delete.\n\n" +
    "Final paragraph.";

  const target = "Paragraph to delete.";
  const start = source.indexOf(target);

  const result = applySourceReplacements(source, [
    {
      start,
      end: start + target.length,
      replacement: ""
    }
  ]);

  assert.equal(
    result,
    "First paragraph.\n\n\n\nFinal paragraph."
  );
});


import {
  planBlockReconciliation
} from "../../assets/js/lilamaya-source-sync.js";


const blocks = (...keys) => keys.map(key => ({ key }));


test("recognises an inserted block between unchanged anchors", () => {
  const result = planBlockReconciliation(
    blocks("A", "B", "C"),
    blocks("A", "B", "X", "C")
  );

  assert.deepEqual(result.regions, [
    {
      originalStart: 2,
      originalEnd: 2,
      currentStart: 2,
      currentEnd: 3
    }
  ]);
});


test("recognises a deleted block between unchanged anchors", () => {
  const result = planBlockReconciliation(
    blocks("A", "B", "X", "C"),
    blocks("A", "B", "C")
  );

  assert.deepEqual(result.regions, [
    {
      originalStart: 2,
      originalEnd: 3,
      currentStart: 2,
      currentEnd: 2
    }
  ]);
});


test("recognises a changed block between unchanged anchors", () => {
  const result = planBlockReconciliation(
    blocks("A", "B", "C"),
    blocks("A", "X", "C")
  );

  assert.deepEqual(result.regions, [
    {
      originalStart: 1,
      originalEnd: 2,
      currentStart: 1,
      currentEnd: 2
    }
  ]);
});


test("recognises a split paragraph as one changed region", () => {
  const result = planBlockReconciliation(
    blocks("A", "original paragraph", "C"),
    blocks("A", "first half", "second half", "C")
  );

  assert.deepEqual(result.regions, [
    {
      originalStart: 1,
      originalEnd: 2,
      currentStart: 1,
      currentEnd: 3
    }
  ]);
});


test("recognises a merged paragraph as one changed region", () => {
  const result = planBlockReconciliation(
    blocks("A", "first paragraph", "second paragraph", "C"),
    blocks("A", "merged paragraph", "C")
  );

  assert.deepEqual(result.regions, [
    {
      originalStart: 1,
      originalEnd: 3,
      currentStart: 1,
      currentEnd: 2
    }
  ]);
});


test("recognises insertion at the beginning and end", () => {
  const result = planBlockReconciliation(
    blocks("A", "B"),
    blocks("X", "A", "B", "Y")
  );

  assert.deepEqual(result.regions, [
    {
      originalStart: 0,
      originalEnd: 0,
      currentStart: 0,
      currentEnd: 1
    },
    {
      originalStart: 2,
      originalEnd: 2,
      currentStart: 3,
      currentEnd: 4
    }
  ]);
});


test("preserves multiple independent changed regions", () => {
  const result = planBlockReconciliation(
    blocks("A", "B", "C", "D", "E"),
    blocks("A", "X", "C", "Y", "E")
  );

  assert.deepEqual(result.regions, [
    {
      originalStart: 1,
      originalEnd: 2,
      currentStart: 1,
      currentEnd: 2
    },
    {
      originalStart: 3,
      originalEnd: 4,
      currentStart: 3,
      currentEnd: 4
    }
  ]);
});


test("rejects repeated identities that could be ambiguous", () => {
  assert.throws(
    () => planBlockReconciliation(
      blocks("A", "repeated", "repeated", "C"),
      blocks("A", "repeated", "C")
    ),
    /Ambiguous repeated block identity/
  );
});


test("rejects reordered unchanged anchors", () => {
  assert.throws(
    () => planBlockReconciliation(
      blocks("A", "B", "C"),
      blocks("A", "C", "B")
    ),
    /Block order changed/
  );
});


test("rejects blocks without identity keys", () => {
  assert.throws(
    () => planBlockReconciliation(
      [{ key: "A" }, {}],
      [{ key: "A" }]
    ),
    /no valid identity key/
  );
});


test("returns no changed regions for an unchanged document", () => {
  const result = planBlockReconciliation(
    blocks("A", "B", "C"),
    blocks("A", "B", "C")
  );

  assert.equal(result.anchors.length, 3);
  assert.deepEqual(result.regions, []);
});


const sourceRegion = (originalStart, originalEnd, currentStart, currentEnd) => ({
  originalStart,
  originalEnd,
  currentStart,
  currentEnd
});

test("builds a replacement for one changed source block", () => {
  const source = "First.\n\nSecond.\n\nThird.";
  const start = source.indexOf("Second.");

  assert.deepEqual(
    buildSourceRegionReplacements(
      source,
      [
        { start: 0, end: 6 },
        { start, end: start + 7 },
        { start: source.indexOf("Third."), end: source.length }
      ],
      { regions: [sourceRegion(1, 2, 1, 2)] },
      ["Revised."]
    ),
    [{ start, end: start + 7, replacement: "Revised." }]
  );
});

test("replaces adjacent blocks as one region, including their internal separator", () => {
  const source = "First.\n\nSecond.\n\nThird.";
  const secondStart = source.indexOf("Second.");
  const thirdStart = source.indexOf("Third.");

  const replacements = buildSourceRegionReplacements(
    source,
    [
      { start: 0, end: 6 },
      { start: secondStart, end: secondStart + 7 },
      { start: thirdStart, end: source.length }
    ],
    { regions: [sourceRegion(1, 3, 1, 2)] },
    ["Combined paragraph."]
  );

  assert.deepEqual(replacements, [{
    start: secondStart,
    end: source.length,
    replacement: "Combined paragraph."
  }]);
});

test("preserves CRLF separators outside a changed region", () => {
  const source = "First.\r\n\r\nSecond.\r\n\r\nThird.";
  const start = source.indexOf("Second.");
  const end = start + "Second.".length;

  const replacements = buildSourceRegionReplacements(
    source,
    [
      { start: 0, end: 6 },
      { start, end },
      { start: source.indexOf("Third."), end: source.length }
    ],
    { regions: [sourceRegion(1, 2, 1, 2)] },
    ["Revised."]
  );

  assert.equal(
    applySourceReplacements(source, replacements),
    "First.\r\n\r\nRevised.\r\n\r\nThird."
  );
});

test("rejects a pure insertion region", () => {
  assert.throws(
    () => buildSourceRegionReplacements(
      "First.",
      [{ start: 0, end: 6 }],
      { regions: [sourceRegion(1, 1, 1, 2)] },
      ["Inserted."]
    ),
    /insertions and deletions are not supported/
  );
});

test("rejects an empty serialization rather than silently deleting source", () => {
  assert.throws(
    () => buildSourceRegionReplacements(
      "First.",
      [{ start: 0, end: 6 }],
      { regions: [sourceRegion(0, 1, 0, 1)] },
      [""]
    ),
    /deletions are not supported/
  );
});

test("rejects a serialized-region count mismatch", () => {
  assert.throws(
    () => buildSourceRegionReplacements(
      "First.",
      [{ start: 0, end: 6 }],
      { regions: [sourceRegion(0, 1, 0, 1)] },
      []
    ),
    /count does not match/
  );
});

test("rejects invalid source block offsets", () => {
  assert.throws(
    () => buildSourceRegionReplacements(
      "First.",
      [{ start: 0, end: 20 }],
      { regions: [] },
      []
    ),
    /Invalid or overlapping/
  );
});

test("rejects overlapping changed regions", () => {
  assert.throws(
    () => buildSourceRegionReplacements(
      "First.\n\nSecond.",
      [
        { start: 0, end: 6 },
        { start: 8, end: 15 }
      ],
      {
        regions: [
          sourceRegion(0, 1, 0, 1),
          sourceRegion(0, 2, 1, 2)
        ]
      },
      ["A.", "B."]
    ),
    /Invalid region boundaries/
  );
});


function fakeNode(id) {
  return {
    id,
    eq(other) {
      return Boolean(other && other.id === id);
    }
  };
}

test("matches unchanged nodes using native node equality", () => {
  const result = planNodeReconciliation(
    ["A", "B", "C"].map(fakeNode),
    ["A", "X", "B", "C"].map(fakeNode)
  );

  assert.deepEqual(
    result.anchors.map(anchor => [
      anchor.originalIndex,
      anchor.currentIndex
    ]),
    [[0, 0], [1, 2], [2, 3]]
  );

  assert.deepEqual(result.regions, [{
    originalStart: 1,
    originalEnd: 1,
    currentStart: 1,
    currentEnd: 2
  }]);
});

test("recognises a deleted node between unchanged anchors", () => {
  const result = planNodeReconciliation(
    ["A", "B", "C"].map(fakeNode),
    ["A", "C"].map(fakeNode)
  );

  assert.deepEqual(result.regions, [{
    originalStart: 1,
    originalEnd: 2,
    currentStart: 1,
    currentEnd: 1
  }]);
});

test("recognises a changed block as one region", () => {
  const result = planNodeReconciliation(
    ["A", "B", "C"].map(fakeNode),
    ["A", "Revised B", "C"].map(fakeNode)
  );

  assert.deepEqual(result.regions, [{
    originalStart: 1,
    originalEnd: 2,
    currentStart: 1,
    currentEnd: 2
  }]);
});

test("recognises a split block as one changed region", () => {
  const result = planNodeReconciliation(
    ["A", "BC", "D"].map(fakeNode),
    ["A", "B", "C", "D"].map(fakeNode)
  );

  assert.deepEqual(result.regions, [{
    originalStart: 1,
    originalEnd: 2,
    currentStart: 1,
    currentEnd: 3
  }]);
});

test("recognises a merged block as one changed region", () => {
  const result = planNodeReconciliation(
    ["A", "B", "C", "D"].map(fakeNode),
    ["A", "BCD"].map(fakeNode)
  );

  assert.deepEqual(result.regions, [{
    originalStart: 1,
    originalEnd: 4,
    currentStart: 1,
    currentEnd: 2
  }]);
});

test("rejects repeated equal nodes when correspondence is ambiguous", () => {
  assert.throws(
    () => planNodeReconciliation(
      ["A", "same", "same", "C"].map(fakeNode),
      ["A", "same", "C"].map(fakeNode)
    ),
    /Ambiguous repeated ProseMirror node/
  );
});

test("rejects reordered unchanged nodes", () => {
  assert.throws(
    () => planNodeReconciliation(
      ["A", "B", "C"].map(fakeNode),
      ["A", "C", "B"].map(fakeNode)
    ),
    /Block order changed/
  );
});

test("rejects objects without native equality", () => {
  assert.throws(
    () => planNodeReconciliation(
      [{ id: "A" }],
      [fakeNode("A")]
    ),
    /does not provide ProseMirror equality/
  );
});

test("returns no changed regions for identical node sequences", () => {
  const result = planNodeReconciliation(
    ["A", "B", "C"].map(fakeNode),
    ["A", "B", "C"].map(fakeNode)
  );

  assert.equal(result.anchors.length, 3);
  assert.deepEqual(result.regions, []);
});


function structuralPlan(originalStart, originalEnd, currentStart, currentEnd) {
  return {
    anchors: [
      { originalIndex: 0, currentIndex: 0 },
      { originalIndex: 2, currentIndex: currentEnd + 1 }
    ],
    regions: [{
      originalStart,
      originalEnd,
      currentStart,
      currentEnd
    }]
  };
}

test("inserts a paragraph between unchanged blocks", () => {
  const source = "First.\n\nThird.";
  const firstEnd = "First.".length;
  const thirdStart = source.indexOf("Third.");

  const replacements = buildSeparatorAwareReplacements(
    source,
    [
      { start: 0, end: firstEnd },
      { start: thirdStart, end: source.length }
    ],
    {
      anchors: [
        { originalIndex: 0, currentIndex: 0 },
        { originalIndex: 1, currentIndex: 2 }
      ],
      regions: [{
        originalStart: 1, originalEnd: 1,
        currentStart: 1, currentEnd: 2
      }]
    },
    ["Second."]
  );

  assert.equal(
    applySourceReplacements(source, replacements),
    "First.\n\nSecond.\n\nThird."
  );
});

test("removes Milkdown trailing newlines before preserving original insertion separators", () => {
  const source = "First.\n\nThird.";
  const firstEnd = "First.".length;
  const thirdStart = source.indexOf("Third.");

  const replacements = buildSeparatorAwareReplacements(
    source,
    [
      { start: 0, end: firstEnd },
      { start: thirdStart, end: source.length }
    ],
    {
      anchors: [
        { originalIndex: 0, currentIndex: 0 },
        { originalIndex: 1, currentIndex: 2 }
      ],
      regions: [{
        originalStart: 1, originalEnd: 1,
        currentStart: 1, currentEnd: 2
      }]
    },
    ["Second.\n\n"]
  );

  assert.equal(
    applySourceReplacements(source, replacements),
    "First.\n\nSecond.\n\nThird."
  );
});

test("deletes a paragraph while retaining one separator", () => {
  const source = "First.\n\nSecond.\n\nThird.";
  const firstEnd = "First.".length;
  const secondStart = source.indexOf("Second.");
  const thirdStart = source.indexOf("Third.");

  const replacements = buildSeparatorAwareReplacements(
    source,
    [
      { start: 0, end: firstEnd },
      { start: secondStart, end: secondStart + 7 },
      { start: thirdStart, end: source.length }
    ],
    {
      anchors: [
        { originalIndex: 0, currentIndex: 0 },
        { originalIndex: 2, currentIndex: 1 }
      ],
      regions: [{
        originalStart: 1, originalEnd: 2,
        currentStart: 1, currentEnd: 1
      }]
    },
    [""]
  );

  assert.equal(
    applySourceReplacements(source, replacements),
    "First.\n\nThird."
  );
});

test("replaces a paragraph while preserving both separators", () => {
  const source = "First.\n\nSecond.\n\nThird.";
  const firstEnd = "First.".length;
  const secondStart = source.indexOf("Second.");
  const thirdStart = source.indexOf("Third.");

  const replacements = buildSeparatorAwareReplacements(
    source,
    [
      { start: 0, end: firstEnd },
      { start: secondStart, end: secondStart + 7 },
      { start: thirdStart, end: source.length }
    ],
    {
      anchors: [
        { originalIndex: 0, currentIndex: 0 },
        { originalIndex: 2, currentIndex: 2 }
      ],
      regions: [{
        originalStart: 1, originalEnd: 2,
        currentStart: 1, currentEnd: 2
      }]
    },
    ["Revised."]
  );

  assert.equal(
    applySourceReplacements(source, replacements),
    "First.\n\nRevised.\n\nThird."
  );
});

test("inserts a paragraph while preserving CRLF separators", () => {
  const source = "First.\r\n\r\nThird.";
  const firstEnd = "First.".length;
  const thirdStart = source.indexOf("Third.");

  const replacements = buildSeparatorAwareReplacements(
    source,
    [
      { start: 0, end: firstEnd },
      { start: thirdStart, end: source.length }
    ],
    {
      anchors: [
        { originalIndex: 0, currentIndex: 0 },
        { originalIndex: 1, currentIndex: 2 }
      ],
      regions: [{
        originalStart: 1, originalEnd: 1,
        currentStart: 1, currentEnd: 2
      }]
    },
    ["Second."]
  );

  assert.equal(
    applySourceReplacements(source, replacements),
    "First.\r\n\r\nSecond.\r\n\r\nThird."
  );
});

test("rejects inconsistent separators instead of guessing", () => {
  const source = "First.\n\nSecond.\nThird.";
  const secondStart = source.indexOf("Second.");
  const thirdStart = source.indexOf("Third.");

  assert.throws(
    () => buildSeparatorAwareReplacements(
      source,
      [
        { start: 0, end: 6 },
        { start: secondStart, end: secondStart + 7 },
        { start: thirdStart, end: source.length }
      ],
      {
        anchors: [
          { originalIndex: 0, currentIndex: 0 },
          { originalIndex: 2, currentIndex: 1 }
        ],
        regions: [{
          originalStart: 1, originalEnd: 2,
          currentStart: 1, currentEnd: 1
        }]
      },
      [""]
    ),
    /surrounding separators differ/
  );
});

test("rejects structural changes at document boundaries", () => {
  const source = "First.\n\nSecond.";
  const secondStart = source.indexOf("Second.");

  assert.throws(
    () => buildSeparatorAwareReplacements(
      source,
      [
        { start: 0, end: 6 },
        { start: secondStart, end: source.length }
      ],
      {
        anchors: [{ originalIndex: 1, currentIndex: 2 }],
        regions: [{
          originalStart: 0, originalEnd: 0,
          currentStart: 0, currentEnd: 1
        }]
      },
      ["Inserted."]
    ),
    /beginning or end are not supported/
  );
});

test("handles two independent structural changes in one manuscript", () => {
  const source = "A.\n\nB.\n\nC.\n\nD.\n\nE.";

  const positions = ["A.", "B.", "C.", "D.", "E."].map(text => {
    const start = source.indexOf(text);
    return { start, end: start + text.length };
  });

  const plan = {
    anchors: [
      { originalIndex: 0, currentIndex: 0 },
      { originalIndex: 2, currentIndex: 1 },
      { originalIndex: 3, currentIndex: 2 },
      { originalIndex: 4, currentIndex: 4 }
    ],
    regions: [
      {
        originalStart: 1,
        originalEnd: 2,
        currentStart: 1,
        currentEnd: 1
      },
      {
        originalStart: 4,
        originalEnd: 4,
        currentStart: 3,
        currentEnd: 4
      }
    ]
  };

  const replacements = buildSeparatorAwareReplacements(
    source,
    positions,
    plan,
    ["", "New D."]
  );

  assert.equal(
    applySourceReplacements(source, replacements),
    "A.\n\nC.\n\nD.\n\nNew D.\n\nE."
  );
});


const realSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    blockquote: { group: "block", content: "block+" },
    text: { group: "inline" }
  },
  marks: {
    strong: {}
  }
});

function realParagraph(value, marks = []) {
  return realSchema.nodes.paragraph.create(
    null,
    value ? [realSchema.text(value, marks)] : []
  );
}

test("uses actual ProseMirror nodes for reconciliation", () => {
  const result = planNodeReconciliation(
    ["A", "B", "C"].map(value => realParagraph(value)),
    ["A", "X", "B", "C"].map(value => realParagraph(value))
  );

  assert.deepEqual(
    result.anchors.map(anchor => [
      anchor.originalIndex,
      anchor.currentIndex
    ]),
    [[0, 0], [1, 2], [2, 3]]
  );

  assert.deepEqual(result.regions, [{
    originalStart: 1,
    originalEnd: 1,
    currentStart: 1,
    currentEnd: 2
  }]);
});

test("recognises formatting differences in actual ProseMirror nodes", () => {
  const plain = realParagraph("Important");
  const bold = realParagraph(
    "Important",
    [realSchema.marks.strong.create()]
  );

  assert.equal(plain.eq(bold), false);

  const result = planNodeReconciliation(
    [realParagraph("Before"), plain, realParagraph("After")],
    [realParagraph("Before"), bold, realParagraph("After")]
  );

  assert.deepEqual(result.regions, [{
    originalStart: 1,
    originalEnd: 2,
    currentStart: 1,
    currentEnd: 2
  }]);
});

test("recognises deletion using actual ProseMirror nodes", () => {
  const result = planNodeReconciliation(
    ["A", "B", "C"].map(value => realParagraph(value)),
    ["A", "C"].map(value => realParagraph(value))
  );

  assert.deepEqual(result.regions, [{
    originalStart: 1,
    originalEnd: 2,
    currentStart: 1,
    currentEnd: 1
  }]);
});

test("recognises insertion using actual ProseMirror nodes", () => {
  const result = planNodeReconciliation(
    ["A", "C"].map(value => realParagraph(value)),
    ["A", "B", "C"].map(value => realParagraph(value))
  );

  assert.deepEqual(result.regions, [{
    originalStart: 1,
    originalEnd: 1,
    currentStart: 1,
    currentEnd: 2
  }]);
});

test("recognises nested blockquote nodes as complete ProseMirror blocks", () => {
  const quote = value => realSchema.nodes.blockquote.create(
    null,
    [realParagraph(value)]
  );

  const result = planNodeReconciliation(
    [realParagraph("A"), quote("Quoted"), realParagraph("C")],
    [realParagraph("A"), quote("Revised quote"), realParagraph("C")]
  );

  assert.deepEqual(result.regions, [{
    originalStart: 1,
    originalEnd: 2,
    currentStart: 1,
    currentEnd: 2
  }]);
});

function runRealNodeSyncFixture(originalTexts, currentTexts) {
  const originalNodes = originalTexts.map(text => realParagraph(text));
  const currentNodes = currentTexts.map(text => realParagraph(text));

  const originalDoc = realSchema.nodes.doc.create(null, originalNodes);
  const currentDoc = realSchema.nodes.doc.create(null, currentNodes);

  const originalBlocks = [];
  const currentBlocks = [];

  originalDoc.forEach(node => originalBlocks.push(node));
  currentDoc.forEach(node => currentBlocks.push(node));

  const originalSource = originalTexts.join("\n\n");
  const sourceBlocks = [];
  let offset = 0;

  for (const text of originalTexts) {
    sourceBlocks.push({
      start: offset,
      end: offset + text.length
    });
    offset += text.length + 2;
  }

  const plan = planNodeReconciliation(originalBlocks, currentBlocks);

  // Test fixture serializer for ordinary paragraphs only.
  const serializedRegions = plan.regions.map(region =>
    currentBlocks
      .slice(region.currentStart, region.currentEnd)
      .map(node => node.textContent)
      .join("\n\n")
  );

  const replacements = buildSeparatorAwareReplacements(
    originalSource,
    sourceBlocks,
    plan,
    serializedRegions
  );

  return applySourceReplacements(originalSource, replacements);
}

test("runs real ProseMirror insertion through the complete sync pipeline", () => {
  assert.equal(
    runRealNodeSyncFixture(
      ["First.", "Third."],
      ["First.", "Second.", "Third."]
    ),
    "First.\n\nSecond.\n\nThird."
  );
});

test("runs real ProseMirror deletion through the complete sync pipeline", () => {
  assert.equal(
    runRealNodeSyncFixture(
      ["First.", "Second.", "Third."],
      ["First.", "Third."]
    ),
    "First.\n\nThird."
  );
});

test("runs real ProseMirror replacement through the complete sync pipeline", () => {
  assert.equal(
    runRealNodeSyncFixture(
      ["First.", "Original.", "Third."],
      ["First.", "Revised.", "Third."]
    ),
    "First.\n\nRevised.\n\nThird."
  );
});
