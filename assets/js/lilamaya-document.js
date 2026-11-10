
/*
 * Lilamaya Document Engine
 *
 * Hugo Markdown remains the authoritative document format.
 *
 * Responsibilities:
 * - Preserve YAML frontmatter exactly.
 * - Identify protected Hugo shortcodes.
 * - Separate ordinary Markdown from protected elements.
 * - Reconstruct the original document without altering its contents.
 */

const FRONTMATTER_PATTERN =
  /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

const SHORTCODE_PATTERN =
  /^[ \t]*\{\{<\s*introduction\s*>\}\}[ \t]*(?:\r?\n|$)|^[ \t]*\{\{<\s*(poetry|invocation)\s*>\}\}[ \t]*\r?\n[\s\S]*?^[ \t]*\{\{<\s*\/\s*\1\s*>\}\}[ \t]*(?:\r?\n|$)/gm;


export function parseHugoDocument(source) {
  if (typeof source !== "string") {
    throw new TypeError("Hugo document must be a string.");
  }

  let frontmatter = "";
  let body = source;

  const frontmatterMatch = source.match(FRONTMATTER_PATTERN);

  if (frontmatterMatch) {
    frontmatter = frontmatterMatch[0];
    body = source.slice(frontmatter.length);
  }

  const segments = [];
  let cursor = 0;
  let match;

  SHORTCODE_PATTERN.lastIndex = 0;

  while ((match = SHORTCODE_PATTERN.exec(body)) !== null) {
    const start = match.index;
    const end = SHORTCODE_PATTERN.lastIndex;

    if (start > cursor) {
      segments.push({
        type: "markdown",
        content: body.slice(cursor, start)
      });
    }

    const shortcode = match[0];

    let type;

    if (/^\s*\{\{<\s*introduction/.test(shortcode)) {
      type = "introduction";
    } else {
      type = match[1];
    }

    segments.push({
      type,
      content: shortcode
    });

    cursor = end;
  }

  if (cursor < body.length) {
    segments.push({
      type: "markdown",
      content: body.slice(cursor)
    });
  }

  // Never silently pass an unrecognised or malformed Lilamaya
  // shortcode into the ordinary Markdown editor.
  for (const segment of segments) {
    if (
      segment.type === "markdown" &&
      /\{\{<\s*\/?(?:introduction|poetry|invocation)\b/.test(
        segment.content
      )
    ) {
      throw new Error(
        "An unmatched or malformed Lilamaya shortcode was found. " +
        "The document has not been processed."
      );
    }
  }

  return {
    frontmatter,
    segments
  };
}



// Read the introduction field without parsing or rewriting the rest
// of the YAML frontmatter. The Writing Desk's API uses folded scalars.
export function readHugoIntroduction(frontmatter) {
  if (typeof frontmatter !== "string") {
    throw new TypeError("Hugo frontmatter must be a string.");
  }

  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex(line => /^introduction:[ \t]*/.test(line));

  if (start < 0) return "";

  const header = lines[start].replace(/^introduction:[ \t]*/, "").trim();

  if (header === '""' || header === "''") return "";

  if (header && !/^[>|][+-]?$/.test(header)) {
    if (header.startsWith('"')) {
      try {
        return JSON.parse(header);
      } catch {
        return header.replace(/^["']|["']$/g, "");
      }
    }

    if (header.startsWith("'")) {
      return header.slice(1, -1).replace(/''/g, "'");
    }

    return header;
  }

  const valueLines = [];

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim() && !/^[ \t]/.test(line)) break;

    valueLines.push(line.replace(/^ {1,2}/, ""));
  }

  while (valueLines.length && valueLines[valueLines.length - 1] === "") {
    valueLines.pop();
  }

  const value = valueLines.join("\n");

  // Literal YAML scalars preserve line breaks exactly.
  // Folded scalars convert ordinary line breaks into spaces.
  if (header.startsWith("|")) {
    return value.trim();
  }

  return value
    .replace(/([^\n])\n([^\n])/g, "$1 $2")
    .trim();
}


// Replace only the introduction field, preserving all other
// frontmatter fields and their original text.
export function updateHugoIntroduction(frontmatter, introduction) {
  if (
    typeof frontmatter !== "string" ||
    typeof introduction !== "string"
  ) {
    throw new TypeError("Invalid introduction update.");
  }

  const newline = frontmatter.includes("\r\n") ? "\r\n" : "\n";
  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex(line => /^introduction:[ \t]*/.test(line));

  const value = introduction.replace(/\r\n/g, "\n").trim();

  const replacement = value
    ? ["introduction: |", ...value.split("\n").map(line => "  " + line)]
    : ['introduction: ""'];

  if (start < 0) {
    // Insert before the closing frontmatter delimiter.
    const closing = lines.findIndex((line, index) =>
      index > 0 && line.trim() === "---"
    );

    if (closing < 0) {
      throw new Error("Cannot add introduction: closing frontmatter delimiter not found.");
    }

    const insertion = [...replacement, ""];
    lines.splice(closing, 0, ...insertion);
    return lines.join(newline);
  }

  let end = start + 1;

  while (
    end < lines.length &&
    (!lines[end].trim() || /^[ \t]/.test(lines[end]))
  ) {
    end++;
  }

  // Preserve the number of blank separator lines after the field.
  let blankCount = 0;
  for (let i = end - 1; i > start && !lines[i].trim(); i--) {
    blankCount++;
  }

  lines.splice(
    start,
    end - start,
    ...replacement,
    ...Array(blankCount).fill("")
  );

  return lines.join(newline);
}

export function serializeHugoDocument(document) {
  if (
    !document ||
    typeof document.frontmatter !== "string" ||
    !Array.isArray(document.segments)
  ) {
    throw new TypeError("Invalid Lilamaya document structure.");
  }

  const body = document.segments.map(segment => {
    if (
      !segment ||
      typeof segment.content !== "string" ||
      !["markdown", "introduction", "poetry", "invocation"].includes(
        segment.type
      )
    ) {
      throw new Error("Invalid document segment.");
    }

    return segment.content;
  }).join("");

  return document.frontmatter + body;
}
