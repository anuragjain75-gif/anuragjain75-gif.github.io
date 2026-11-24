
import fs from "node:fs";
import assert from "node:assert/strict";

import {
  parseHugoDocument,
  serializeHugoDocument
} from "../../assets/js/lilamaya-document.js";


const file =
  "content/essays/the-art-of-becoming-whole/index.md";

const original = fs.readFileSync(file, "utf8");

const parsed = parseHugoDocument(original);

const reconstructed = serializeHugoDocument(parsed);


console.log("\n===== LILAMAYA DOCUMENT TEST =====");

console.log(
  "Frontmatter:",
  parsed.frontmatter ? "FOUND" : "NOT FOUND"
);

console.log(
  "Total segments:",
  parsed.segments.length
);

for (const type of [
  "markdown",
  "introduction",
  "poetry",
  "invocation"
]) {
  const count = parsed.segments.filter(
    segment => segment.type === type
  ).length;

  console.log(`${type}: ${count}`);
}

console.log("\n===== ROUND-TRIP VERIFICATION =====");

assert.equal(
  reconstructed,
  original,
  "Reconstructed document differs from original."
);

console.log("PASS: Original document reconstructed character for character.");

assert.ok(
  parsed.segments.some(segment => segment.type === "introduction"),
  "Introduction shortcode was not detected."
);

assert.ok(
  parsed.segments.some(segment => segment.type === "poetry"),
  "Poetry shortcode was not detected."
);

console.log("PASS: Protected shortcodes detected.");

console.log("\nAll document-preservation tests passed.");
