
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

import {
  parseHugoDocument,
  serializeHugoDocument
} from "../../assets/js/lilamaya-document.js";


const root = "content";

const totals = {
  files: 0,
  markdown: 0,
  introduction: 0,
  poetry: 0,
  invocation: 0
};

const failures = [];


function walk(directory) {
  for (const entry of fs.readdirSync(directory, {
    withFileTypes: true
  })) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }

    if (!entry.name.endsWith(".md")) continue;

    totals.files++;

    try {
      const original = fs.readFileSync(fullPath, "utf8");
      const parsed = parseHugoDocument(original);
      const reconstructed = serializeHugoDocument(parsed);

      assert.equal(reconstructed, original);

      for (const segment of parsed.segments) {
        totals[segment.type]++;
      }

    } catch (error) {
      failures.push({
        file: fullPath,
        error: error.message
      });
    }
  }
}


walk(root);

console.log("\n===== LILAMAYA COLLECTION TEST =====");

console.log("Markdown files:", totals.files);
console.log("Markdown segments:", totals.markdown);
console.log("Introduction:", totals.introduction);
console.log("Poetry:", totals.poetry);
console.log("Invocation:", totals.invocation);

console.log("\n===== RESULTS =====");

if (failures.length) {
  console.error("FAILED DOCUMENTS:", failures.length);

  for (const failure of failures) {
    console.error(failure.file);
    console.error(failure.error);
  }

  process.exitCode = 1;

} else {
  console.log("PASS: Every Markdown document reconstructed exactly.");
  console.log("PASS: No malformed Lilamaya shortcodes detected.");
}
