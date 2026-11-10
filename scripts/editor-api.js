const http = require("http");
const fs = require("fs");
const nodePath = require("path");
const matter = require("gray-matter");
const {execFileSync} = require("child_process");

const GITHUB_OWNER = "anuragjain75-gif";
const GITHUB_REPO = "anuragjain75-gif.github.io";
const GITHUB_BRANCH = "main";

// Use Git's secure credential store when no environment token is supplied.
if (!process.env.GITHUB_TOKEN) {
  try {
    const credentials = execFileSync(
      "git",
      ["credential", "fill"],
      {
        input: "protocol=https\nhost=github.com\n\n",
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"]
      }
    );

    const match = credentials.match(/^password=(.+)$/m);

    if (!match) {
      throw new Error("No GitHub password/token was returned.");
    }

    process.env.GITHUB_TOKEN = match[1];
    console.log("GitHub credential loaded from Git credential manager.");
  } catch (error) {
    console.error("Could not load GitHub credentials:", error.message);
    process.exit(1);
  }
}

function updateConnectionsFrontmatter(content, connections) {
  const parsed = matter(content);

  if (!content.startsWith("---")) {
    throw new Error("Document has no YAML frontmatter");
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);

  if (!match) {
    throw new Error("Could not locate YAML frontmatter");
  }

  const originalYaml = match[1];
  const serialized = matter.stringify("", {connections});
  const serializedMatch = serialized.match(/^---\r?\n([\s\S]*?)\r?\n---/);

  if (!serializedMatch) {
    throw new Error("Could not serialize connections");
  }

  const connectionsYaml = serializedMatch[1].replace(/^connections:/, "connections:");

  const lines = originalYaml.split(/\r?\n/);
  const start = lines.findIndex(line => /^connections\s*:/.test(line));

  let updatedLines;

  if (start === -1) {
    updatedLines = [...lines, connectionsYaml];
  } else {
    let end = start + 1;

    while (
      end < lines.length &&
      (lines[end] === "" || /^[ \t]/.test(lines[end]))
    ) {
      end++;
    }

    updatedLines = [
      ...lines.slice(0, start),
      connectionsYaml,
      ...lines.slice(end)
    ];
  }

  const updated = content.replace(
    match[0],
    `---\n${updatedLines.join("\n")}\n---`
  );

  const validated = matter(updated);

  if (!Array.isArray(validated.data.connections)) {
    throw new Error("Updated connections field is invalid");
  }

  return updated;
}

function listHugoPermalinks() {
  const repoRoot = nodePath.resolve(__dirname, "..");

  const output = execFileSync("hugo", ["list", "all"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });

  const lines = output.trim().split(/\r?\n/);
  const permalinks = new Map();

  for (const line of lines.slice(1)) {
    const firstComma = line.indexOf(",");
    const lastComma = line.lastIndexOf(",");

    if (firstComma === -1 || lastComma <= firstComma) continue;

    const documentPath = line.slice(0, firstComma);
    const permalink = line.slice(lastComma + 1).replace(/^"|"$/g, "");

    if (!isAllowedPath(documentPath) || !permalink) continue;

    permalinks.set(
      documentPath,
      new URL(permalink).pathname
    );
  }

  return permalinks;
}

function isAllowedPath(path) {
  const allowed = [
    "content/essays/",
    "content/fragments/",
    "content/paintings/",
    "content/people/",
    "content/works/",
    "content/ideas/",
    "content/traditions/",
    "content/places/",
    "content/journeys/"
  ];

  return (
    typeof path === "string" &&
    !path.includes("..") &&
    !path.startsWith("/") &&
    allowed.some(prefix => path.startsWith(prefix)) &&
    path.endsWith(".md")
  );
}


function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    function fail(error) {
      if (settled) return;
      settled = true;
      reject(error);
    }

    req.on("data", chunk => {
      if (settled) return;

      totalBytes += chunk.length;

      if (totalBytes > maxBytes) {
        const error = new Error("Request body is too large");
        error.statusCode = 413;
        fail(error);
        req.resume();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", fail);
    req.on("aborted", () => {
      const error = new Error("Request was interrupted");
      error.statusCode = 400;
      fail(error);
    });
  });
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

function validateImageContent(path, base64Content) {
  const normalized = base64Content.replace(/[\r\n]/g, "");

  if (
    !normalized ||
    normalized.length % 4 !== 0
  ) {
    throw new ValidationError("Invalid Base64 image data");
  }

  const imageBuffer = Buffer.from(normalized, "base64");

  if (!imageBuffer.length || imageBuffer.toString("base64") !== normalized) {
    throw new ValidationError("Invalid or empty image data");
  }

  let detectedFormat = null;

  if (
    imageBuffer.length >= 3 &&
    imageBuffer[0] === 0xFF &&
    imageBuffer[1] === 0xD8 &&
    imageBuffer[2] === 0xFF
  ) {
    detectedFormat = "jpg";
  } else if (
    imageBuffer.length >= 8 &&
    imageBuffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    )
  ) {
    detectedFormat = "png";
  } else if (
    imageBuffer.length >= 12 &&
    imageBuffer.toString("ascii", 0, 4) === "RIFF" &&
    imageBuffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    detectedFormat = "webp";
  }

  if (!detectedFormat) {
    throw new ValidationError("The uploaded file is not a supported image");
  }

  const requestedExtension = path.split(".").pop().toLowerCase();

  const expectedFormat =
    requestedExtension === "jpeg" ? "jpg" : requestedExtension;

  if (detectedFormat !== expectedFormat) {
    throw new ValidationError(
      "The image content does not match its file extension"
    );
  }
}

const ALLOWED_RELATIONS = new Set([
  "authored",
  "authored-by",
  "explores",
  "influenced",
  "influenced-by",
  "disagrees-with",
  "belongs-to",
  "related-to"
]);

const ALLOWED_BASES = new Set(["documented", "interpretive"]);

function validateConnections(connections, currentPermalink = null) {
  if (!Array.isArray(connections)) {
    throw new ValidationError("Connections must be an array");
  }

  if (connections.length > 50) {
    throw new ValidationError("A document cannot have more than 50 connections");
  }

  const validTargets = new Set(listHugoPermalinks().values());
  const seenTargets = new Set();

  return connections.map(connection => {
    if (!connection || typeof connection !== "object" || Array.isArray(connection)) {
      throw new ValidationError("Invalid connection");
    }

    const {target, relation, note} = connection;
    const basis = connection.basis || "interpretive";

    if (typeof target !== "string" || !validTargets.has(target)) {
      throw new ValidationError("Connection target does not match an existing Hugo permalink: " + target);
    }

    if (target === currentPermalink) {
      throw new ValidationError("A document cannot be connected to itself");
    }

    if (seenTargets.has(target)) {
      throw new ValidationError("Duplicate connection target: " + target);
    }

    seenTargets.add(target);

    if (typeof relation !== "string" || !ALLOWED_RELATIONS.has(relation)) {
      throw new ValidationError("Invalid relationship type: " + relation);
    }

    if (typeof basis !== "string" || !ALLOWED_BASES.has(basis)) {
      throw new ValidationError("Invalid relationship basis: " + basis);
    }

    if (note !== undefined && (typeof note !== "string" || note.length > 500)) {
      throw new ValidationError("Connection notes must not exceed 500 characters");
    }

    return {
      target,
      relation,
      basis,
      ...(typeof note === "string" && note.trim()
        ? {note: note.trim()}
        : {})
    };
  });
}

async function getGitHubFile(path) {
  const url =
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}` +
    `?ref=${GITHUB_BRANCH}`;

  const response = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || `GitHub error ${response.status}`);
  }

  return {
    path: data.path,
    sha: data.sha,
    content: Buffer.from(data.content, "base64").toString("utf8")
  };
}

async function updateGitHubFile(path, content, sha) {
  const url =
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: `Update ${path}`,
      content: Buffer.from(content, "utf8").toString("base64"),
      sha,
      branch: GITHUB_BRANCH
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || `GitHub error ${response.status}`);
  }

  return {
    path: data.content.path,
    sha: data.content.sha,
    commit: data.commit.sha
  };
}

async function createGitHubFile(path, content) {
  const url =
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: `Create ${path}`,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch: GITHUB_BRANCH
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || `GitHub error ${response.status}`);
  }

  return {
    path: data.content.path,
    sha: data.content.sha,
    commit: data.commit.sha
  };
}

async function createGitHubBinaryFile(path, base64Content) {
  const url =
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: `Create ${path}`,
      content: base64Content,
      branch: GITHUB_BRANCH
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || `GitHub error ${response.status}`);
  }

  return {
    path: data.content.path,
    sha: data.content.sha,
    commit: data.commit.sha
  };
}

async function deleteGitHubFile(path, sha) {
  const url =
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;

  const response = await fetch(url, {
    method: "DELETE",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: `Delete ${path}`,
      sha,
      branch: GITHUB_BRANCH
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || `GitHub error ${response.status}`);
  }

  return {
    path,
    commit: data.commit.sha
  };
}

function listLocalDocuments() {
  const contentRoot = nodePath.resolve(__dirname, "..", "content");
  const documents = [];

  function scanDirectory(directory) {
    if (!fs.existsSync(directory)) return;

    for (const item of fs.readdirSync(directory, {withFileTypes: true})) {
      const fullPath = nodePath.join(directory, item.name);

      if (item.isDirectory()) {
        scanDirectory(fullPath);
        continue;
      }

      if (!item.isFile() || !item.name.endsWith(".md") ||
          item.name === "_index.md") {
        continue;
      }

      const relativePath = nodePath.relative(
        nodePath.resolve(__dirname, ".."),
        fullPath
      ).split(nodePath.sep).join("/");

      if (!isAllowedPath(relativePath)) continue;

      const content = fs.readFileSync(fullPath, "utf8");
      const match = content.match(/^title:\s*["']?(.+?)["']?\s*$/m);

      documents.push({
        path: relativePath,
        title: match ? match[1] : relativePath
      });
    }
  }

  for (const section of [
    "essays", "fragments", "paintings",
    "people", "works", "ideas",
    "traditions", "places", "journeys"
  ]) {
    scanDirectory(nodePath.join(contentRoot, section));
  }

  return documents;
}

async function listGitHubDocuments() {
  const url =
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`;

  const response = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || `GitHub error ${response.status}`);
  }

  const documents = [];

  for (const item of data.tree || []) {
    if (
      item.type !== "blob" ||
      !item.path.endsWith(".md") ||
      item.path.endsWith("/_index.md") ||
      !isAllowedPath(item.path)
    ) {
      continue;
    }

    const file = await getGitHubFile(item.path);
    const match = file.content.match(/^title:\s*["']?(.+?)["']?\s*$/m);

    documents.push({
      path: item.path,
      title: match ? match[1] : item.path
    });
  }

  return documents;
}



async function githubApiRequest(endpoint, options = {}) {
  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}${endpoint}`,
    {
      ...options,
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.headers || {})
      }
    }
  );

  const responseText = await response.text();
  let data = {};

  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch {
      const error = new Error(
        `GitHub returned an invalid response (HTTP ${response.status})`
      );
      error.statusCode = response.status;
      throw error;
    }
  }

  if (!response.ok) {
    const error = new Error(
      data.message || `GitHub error ${response.status}`
    );
    error.statusCode = response.status;
    throw error;
  }

  return data;
}


function replaceEssayThemeFrontmatter(content, oldTheme, newTheme) {
  const frontmatterMatch = content.match(
    /^---\r?\n([\s\S]*?)\r?\n---/
  );

  if (!frontmatterMatch) {
    throw new Error("Essay has no valid YAML frontmatter");
  }

  const parsed = matter(content);
  const themes = parsed.data.themes;

  if (!Array.isArray(themes)) {
    throw new Error("Essay themes field is not a YAML array");
  }

  if (!themes.includes(oldTheme)) {
    return null;
  }

  // Replace the first occurrence and remove any duplicate old entries.
  // Preserve the position of the first occurrence and all other entries.
  const updatedThemes = [];
  let insertedNewTheme = false;

  for (const theme of themes) {
    if (theme === oldTheme) {
      if (!insertedNewTheme && !themes.includes(newTheme)) {
        updatedThemes.push(newTheme);
        insertedNewTheme = true;
      }
      continue;
    }

    if (theme === newTheme) {
      if (!insertedNewTheme) {
        updatedThemes.push(theme);
        insertedNewTheme = true;
      }
      continue;
    }

    updatedThemes.push(theme);
  }

  if (!insertedNewTheme) {
    updatedThemes.push(newTheme);
  }

  const yamlLines = frontmatterMatch[1].split(/\r?\n/);
  const themesStart = yamlLines.findIndex(line =>
    /^themes\s*:/.test(line)
  );

  if (themesStart === -1) {
    throw new Error("Could not locate themes field in essay frontmatter");
  }

  if (!/^themes\s*:\s*$/.test(yamlLines[themesStart])) {
    throw new Error(
      "Essay uses an unsupported inline themes format; refusing to rewrite it."
    );
  }

  let themesEnd = themesStart + 1;

  while (
    themesEnd < yamlLines.length &&
    (
      yamlLines[themesEnd] === "" ||
      /^[ \t]/.test(yamlLines[themesEnd])
    )
  ) {
    themesEnd++;
  }

  const serialized = matter.stringify("", {
    themes: updatedThemes
  });

  const serializedMatch = serialized.match(
    /^---\r?\n([\s\S]*?)\r?\n---/
  );

  if (!serializedMatch) {
    throw new Error("Could not serialize updated essay themes");
  }

  const replacementLines = serializedMatch[1].split(/\r?\n/);

  const updatedYamlLines = [
    ...yamlLines.slice(0, themesStart),
    ...replacementLines,
    ...yamlLines.slice(themesEnd)
  ];

  const updatedFrontmatter = `---\n${updatedYamlLines.join("\n")}\n---`;

  const updatedContent = content.replace(
    frontmatterMatch[0],
    updatedFrontmatter
  );

  const verified = matter(updatedContent);

  if (
    !Array.isArray(verified.data.themes) ||
    verified.data.themes.includes(oldTheme) ||
    !verified.data.themes.includes(newTheme)
  ) {
    throw new Error("Updated essay themes failed validation");
  }

  return updatedContent;
}


async function getGitHubBlobContent(sha) {
  const blob = await githubApiRequest(`/git/blobs/${sha}`);

  if (blob.encoding !== "base64" || typeof blob.content !== "string") {
    throw new Error("GitHub returned an unsupported blob encoding");
  }

  return Buffer.from(blob.content, "base64").toString("utf8");
}


async function renameGitHubEssayTheme(oldTheme, newTheme) {
  const themesPath = "static/editor-data/essay-themes.json";

  // Capture the current branch commit.
  const reference = await githubApiRequest(
    `/git/ref/heads/${GITHUB_BRANCH}`
  );

  const parentSha = reference.object.sha;

  const parentCommit = await githubApiRequest(
    `/git/commits/${parentSha}`
  );

  const baseTreeSha = parentCommit.tree.sha;

  // Read the repository tree from the same commit.
  const treeData = await githubApiRequest(
    `/git/trees/${baseTreeSha}?recursive=1`
  );

  if (treeData.truncated) {
    throw new Error(
      "GitHub returned an incomplete repository tree. Rename cancelled safely."
    );
  }

  const themesTreeEntry = treeData.tree.find(item =>
    item.type === "blob" && item.path === themesPath
  );

  if (!themesTreeEntry) {
    throw new Error("Theme collection was not found in the captured Git tree");
  }

  const themesContent = await getGitHubBlobContent(themesTreeEntry.sha);
  const themes = JSON.parse(themesContent);

  if (!Array.isArray(themes)) {
    throw new Error("The essay themes file is not a valid array");
  }

  if (!themes.includes(oldTheme)) {
    const error = new Error("The original theme no longer exists");
    error.statusCode = 404;
    throw error;
  }

  if (themes.includes(newTheme)) {
    throw new ValidationError(
      "A theme with the new name already exists"
    );
  }

  const updatedThemes = themes
    .map(theme => theme === oldTheme ? newTheme : theme)
    .sort((a, b) => a.localeCompare(b));

  const essayFiles = treeData.tree.filter(item =>
    item.type === "blob" &&
    item.path.startsWith("content/essays/") &&
    item.path.endsWith(".md") &&
    !item.path.endsWith("/_index.md") &&
    isAllowedPath(item.path)
  );

  const changes = [];
  const affectedEssays = [];

  for (const item of essayFiles) {
    const content = await getGitHubBlobContent(item.sha);
    const parsed = matter(content);

    if (
      !Array.isArray(parsed.data.themes) ||
      !parsed.data.themes.includes(oldTheme)
    ) {
      continue;
    }

    const updatedContent = replaceEssayThemeFrontmatter(
      content,
      oldTheme,
      newTheme
    );

    if (updatedContent === null) continue;

    const blob = await githubApiRequest("/git/blobs", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        content: updatedContent,
        encoding: "utf-8"
      })
    });

    changes.push({
      path: item.path,
      mode: "100644",
      type: "blob",
      sha: blob.sha
    });

    affectedEssays.push({
      path: item.path,
      title: typeof parsed.data.title === "string"
        ? parsed.data.title
        : item.path
    });
  }

  // Create the new theme collection blob.
  const themesBlob = await githubApiRequest("/git/blobs", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      content: JSON.stringify(updatedThemes, null, 2) + "\n",
      encoding: "utf-8"
    })
  });

  changes.push({
    path: themesPath,
    mode: "100644",
    type: "blob",
    sha: themesBlob.sha
  });

  // Prepare one tree containing every changed file.
  const newTree = await githubApiRequest("/git/trees", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: changes
    })
  });

  // Create one commit with the original branch commit as its parent.
  const commit = await githubApiRequest("/git/commits", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      message: `Rename essay theme: ${oldTheme} to ${newTheme}`,
      tree: newTree.sha,
      parents: [parentSha]
    })
  });

  // Non-forced reference update: concurrent branch changes are rejected.
  const updatedReference = await githubApiRequest(
    `/git/refs/heads/${GITHUB_BRANCH}`,
    {
      method: "PATCH",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        sha: commit.sha,
        force: false
      })
    }
  );

  return {
    themes: updatedThemes,
    affectedEssays,
    affectedCount: affectedEssays.length,
    commit: commit.sha,
    branch: updatedReference.ref
  };
}

async function getGitHubThemeUsage(theme) {
  const url =
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`;

  const response = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || `GitHub error ${response.status}`);
  }

  if (data.truncated) {
    throw new Error(
      "GitHub returned an incomplete repository tree. Theme usage cannot be verified safely."
    );
  }

  const essays = [];

  const essayFiles = (data.tree || []).filter(item =>
    item.type === "blob" &&
    item.path.startsWith("content/essays/") &&
    item.path.endsWith(".md") &&
    !item.path.endsWith("/_index.md") &&
    isAllowedPath(item.path)
  );

  for (const item of essayFiles) {
    const file = await getGitHubFile(item.path);
    const parsed = matter(file.content);
    const themes = parsed.data.themes;

    if (!Array.isArray(themes)) continue;

    if (themes.includes(theme)) {
      essays.push({
        path: item.path,
        title: typeof parsed.data.title === "string"
          ? parsed.data.title
          : item.path
      });
    }
  }

  return essays;
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "http://localhost:1313");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/api/save") {
    try {
      const body = await readRequestBody(req, 5 * 1024 * 1024);
      let {path, content, sha, connections} = JSON.parse(body);

        if (
          typeof path !== "string" ||
          typeof content !== "string" ||
          typeof sha !== "string"
        ) {
          throw new Error("path, content, and sha are required");
        }

        if (!isAllowedPath(path)) {
          throw new Error("Path is not allowed");
        }

        // Update only the connections field in the Markdown frontmatter.
        if (Array.isArray(connections)) {
          const currentPermalink = listHugoPermalinks().get(path);
          const cleanConnections = validateConnections(
            connections,
            currentPermalink
          );

          content = updateConnectionsFrontmatter(content, cleanConnections);
        }

        if (sha === "LOCAL") {
          const localPath = nodePath.resolve(__dirname, "..", path);

          if (!localPath.startsWith(nodePath.resolve(__dirname, "..") + nodePath.sep)) {
            throw new Error("Invalid local path");
          }

          if (!fs.existsSync(localPath)) {
            throw new Error("Local document no longer exists");
          }

          fs.writeFileSync(localPath, content, "utf8");

          res.writeHead(200, {"Content-Type": "application/json"});
          res.end(JSON.stringify({
            ok: true,
            path,
            sha: "LOCAL"
          }));
          return;
        }

        const currentFile = await getGitHubFile(path);

        if (currentFile.sha !== sha) {
          res.writeHead(409, {"Content-Type": "application/json"});
          res.end(JSON.stringify({
            error: "File changed on GitHub since it was opened",
            currentSha: currentFile.sha
          }));
          return;
        }

        const updated = await updateGitHubFile(path, content, sha);

        console.log("GitHub file updated:", updated.path);
        console.log("New SHA:", updated.sha);
        console.log("Commit:", updated.commit);

        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({
          ok: true,
          path: updated.path,
          sha: updated.sha,
          commit: updated.commit
        }));
      } catch (error) {
        console.error("Save error:", error.message);

        const statusCode =
          error.statusCode ||
          (error instanceof ValidationError ? 400 : 500);

        res.writeHead(statusCode, {"Content-Type": "application/json"});
        res.end(JSON.stringify({error: error.message}));
      }

    return;
  }

  if (req.method === "POST" && req.url === "/api/upload-image") {
    try {
      const body = await readRequestBody(req, 12 * 1024 * 1024);
      const {path, content, local} = JSON.parse(body);

      if (typeof path !== "string" || typeof content !== "string") {
        throw new ValidationError("path and content are required");
      }

      const allowedHeroPath =
        /^content\/essays\/[a-z0-9-]+\/hero\.(jpg|jpeg|png|webp)$/i;

      const allowedInlinePath =
        /^content\/essays\/[a-z0-9-]+\/images\/[a-z0-9][a-z0-9_-]{0,79}\.(jpg|jpeg|png|webp)$/i;

      if (!allowedHeroPath.test(path) && !allowedInlinePath.test(path)) {
        throw new ValidationError("Image path is not allowed");
      }

      if (local !== undefined && typeof local !== "boolean") {
        throw new ValidationError("Invalid local upload flag");
      }

      if (!/^[A-Za-z0-9+/=\r\n]+$/.test(content)) {
        throw new ValidationError("Invalid image data");
      }

      validateImageContent(path, content);

      let uploaded;

      if (local === true) {
        const repositoryRoot = nodePath.resolve(__dirname, "..");
        const localPath = nodePath.resolve(repositoryRoot, path);

        if (!localPath.startsWith(repositoryRoot + nodePath.sep)) {
          throw new ValidationError("Invalid local image path");
        }

        fs.mkdirSync(nodePath.dirname(localPath), {recursive: true});

        const imageBuffer = Buffer.from(
          content.replace(/[\r\n]/g, ""),
          "base64"
        );

        fs.writeFileSync(localPath, imageBuffer, {flag: "wx"});

        uploaded = {
          path,
          sha: "LOCAL",
          commit: null
        };
      } else {
        uploaded = await createGitHubBinaryFile(path, content);
      }

      console.log("Essay image uploaded:", uploaded.path);
      if (uploaded.commit) {
        console.log("Commit:", uploaded.commit);
      }

      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({
        ok: true,
        path: uploaded.path,
        sha: uploaded.sha,
        commit: uploaded.commit
      }));

    } catch (error) {
      console.error("Image upload error:", error.message);

      const statusCode =
        error.statusCode ||
        (error instanceof ValidationError || error instanceof SyntaxError
          ? 400
          : 500);

      res.writeHead(statusCode, {"Content-Type": "application/json"});
      res.end(JSON.stringify({error: error.message}));
    }

    return;
  }

  if (req.method === "POST" && req.url === "/api/new-essay") {
    try {
      const body = await readRequestBody(req, 1024 * 1024);
      const {title, introduction, themes, date} = JSON.parse(body);

      if (
        typeof title !== "string" ||
        !title.trim() ||
        title.trim().length > 200
      ) {
        throw new ValidationError("A valid title is required (maximum 200 characters)");
      }

      const cleanTitle = title.trim();
      const cleanIntroduction =
        typeof introduction === "string" ? introduction.trim() : "";

      if (cleanIntroduction.length > 2000) {
        throw new ValidationError("Introduction must not exceed 2000 characters");
      }

      if (themes !== undefined && !Array.isArray(themes)) {
        throw new ValidationError("Themes must be an array");
      }

      const cleanThemes = (themes || [])
        .map(theme => {
          if (typeof theme !== "string" || theme.trim().length > 100) {
            throw new ValidationError("Each theme must be text of at most 100 characters");
          }
          return theme.trim();
        })
        .filter(Boolean);

      if (cleanThemes.length > 50) {
        throw new ValidationError("An essay cannot have more than 50 themes");
      }

      const slug = cleanTitle
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

      if (!slug) {
        throw new ValidationError("Could not create a valid slug from the title");
      }

      const markdownPath = `content/essays/${slug}/index.md`;

      const essayDate =
        typeof date === "string" && date.trim()
          ? date.trim()
          : new Date().toISOString().slice(0, 10);

      if (!/^\d{4}-\d{2}-\d{2}$/.test(essayDate)) {
        throw new ValidationError("Date must use YYYY-MM-DD format");
      }

      const parsedDate = new Date(`${essayDate}T00:00:00Z`);

      if (
        Number.isNaN(parsedDate.getTime()) ||
        parsedDate.toISOString().slice(0, 10) !== essayDate
      ) {
        throw new ValidationError("Date is not a valid calendar date");
      }

      let frontMatter = `---
title: ${JSON.stringify(cleanTitle)}
`;

      if (cleanIntroduction) {
        frontMatter += `introduction: ${JSON.stringify(cleanIntroduction)}
`;
      }

      frontMatter += `date: ${JSON.stringify(essayDate)}
draft: true
`;

      if (cleanThemes.length) {
        frontMatter += "themes:\n";
        for (const theme of cleanThemes) {
          frontMatter += `  - ${JSON.stringify(theme)}\n`;
        }
      }

      frontMatter += "---\n\n";

      const created = await createGitHubFile(markdownPath, frontMatter);

      res.writeHead(201, {"Content-Type": "application/json"});
      res.end(JSON.stringify({
        ok: true,
        path: created.path,
        sha: created.sha,
        commit: created.commit,
        slug
      }));

    } catch (error) {
      console.error("New essay error:", error.message);

      res.writeHead(
        error.statusCode || (error instanceof ValidationError ? 400 : 500),
        {"Content-Type": "application/json"}
      );
      res.end(JSON.stringify({error: error.message}));
    }

    return;
  }

  if (
    req.method === "POST" &&
    new URL(req.url, "http://localhost:1314").pathname === "/api/new-entry"
  ) {
    try {
      const body = await readRequestBody(req, 1024 * 1024);
      const data = JSON.parse(body);

      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new ValidationError("Invalid entry data");
      }

      const sections = {
        people: "people",
        works: "works",
        ideas: "ideas",
        traditions: "traditions",
        places: "places",
        journeys: "journeys"
      };

      const section = sections[data.type];

      if (!section) {
        throw new ValidationError("Invalid entry type");
      }

      if (
        typeof data.title !== "string" ||
        !data.title.trim() ||
        data.title.trim().length > 200
      ) {
        throw new ValidationError("A valid title is required (maximum 200 characters)");
      }

      const title = data.title.trim();
      const description =
        typeof data.description === "string"
          ? data.description.trim()
          : "";

      if (description.length > 1000) {
        throw new ValidationError("Description must not exceed 1000 characters");
      }

      const slug = title
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

      if (!slug) {
        throw new ValidationError("Could not create a valid URL slug from the title");
      }

      let date;

      if (data.date === undefined || data.date === null || data.date === "") {
        date = new Date().toISOString().slice(0, 10);
      } else {
        if (
          typeof data.date !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(data.date)
        ) {
          throw new ValidationError("Date must use YYYY-MM-DD format");
        }

        const parsedDate = new Date(`${data.date}T00:00:00Z`);

        if (
          Number.isNaN(parsedDate.getTime()) ||
          parsedDate.toISOString().slice(0, 10) !== data.date
        ) {
          throw new ValidationError("Date is not a valid calendar date");
        }

        date = data.date;
      }

      const stage =
        typeof data.stage === "string" && data.stage.trim()
          ? data.stage.trim()
          : "seed";

      if (stage.length > 40) {
        throw new ValidationError("Stage must not exceed 40 characters");
      }

      const markdownPath = `content/${section}/${slug}/index.md`;

      if (!isAllowedPath(markdownPath)) {
        throw new ValidationError("Invalid content path");
      }

      if (
        data.connections !== undefined &&
        !Array.isArray(data.connections)
      ) {
        throw new ValidationError("Connections must be an array");
      }

      const connections = data.connections || [];
      const currentPermalink = `/${section}/${slug}/`;

      const cleanConnections = validateConnections(
        connections,
        currentPermalink
      );

      const entryBody =
        typeof data.body === "string" ? data.body : "";

      if (entryBody.length > 200000) {
        throw new ValidationError("Entry body is too large");
      }

      let frontMatter = `---
title: ${JSON.stringify(title)}
date: ${JSON.stringify(date)}
draft: true
description: ${JSON.stringify(description)}
stage: ${JSON.stringify(stage)}
`;

      if (cleanConnections.length) {
        frontMatter += "connections:\n";

        for (const connection of cleanConnections) {
          frontMatter +=
            `  - target: ${JSON.stringify(connection.target)}\n` +
            `    relation: ${JSON.stringify(connection.relation)}\n` +
            `    basis: ${JSON.stringify(connection.basis)}\n`;

          if (connection.note) {
            frontMatter +=
              `    note: ${JSON.stringify(connection.note)}\n`;
          }
        }
      }

      frontMatter += "---\n\n";

      const content = frontMatter + entryBody;
      const requestUrl = new URL(req.url, "http://localhost:1314");
      const localMode = requestUrl.searchParams.get("local") === "1";

      let created;

      if (localMode) {
        const localPath = nodePath.resolve(__dirname, "..", markdownPath);
        const contentRoot = nodePath.resolve(__dirname, "..", "content");

        if (!localPath.startsWith(contentRoot + nodePath.sep)) {
          throw new ValidationError("Invalid local content path");
        }

        fs.mkdirSync(nodePath.dirname(localPath), {recursive: true});

        try {
          fs.writeFileSync(localPath, content, {
            encoding: "utf8",
            flag: "wx"
          });
        } catch (error) {
          if (error.code === "EEXIST") {
            error.statusCode = 409;
          }
          throw error;
        }

        created = {
          path: markdownPath,
          sha: "LOCAL",
          commit: null
        };

        console.log("Local test entry created:", markdownPath);
      } else {
        created = await createGitHubFile(markdownPath, content);
      }

      res.writeHead(201, {"Content-Type": "application/json"});
      res.end(JSON.stringify({
        ok: true,
        type: data.type,
        path: created.path,
        sha: created.sha,
        commit: created.commit,
        local: localMode,
        slug
      }));

    } catch (error) {
      console.error("New entry error:", error.message);

      const statusCode =
        error.statusCode ||
        (error instanceof ValidationError || error instanceof SyntaxError
          ? 400
          : 500);

      res.writeHead(statusCode, {"Content-Type": "application/json"});
      res.end(JSON.stringify({error: error.message}));
    }

    return;
  }


  if (
    req.method === "GET" &&
    new URL(req.url, "http://localhost:1314").pathname === "/api/essay-theme-usage"
  ) {
    try {
      const url = new URL(req.url, "http://localhost:1314");
      const theme = url.searchParams.get("theme");

      if (!theme || !theme.trim() || theme.length > 100) {
        throw new ValidationError("A valid theme is required");
      }

      const currentFile = await getGitHubFile(
        "static/editor-data/essay-themes.json"
      );
      const themes = JSON.parse(currentFile.content);

      if (!Array.isArray(themes)) {
        throw new Error("The essay themes file is not a valid array");
      }

      if (!themes.includes(theme)) {
        res.writeHead(404, {"Content-Type": "application/json"});
        res.end(JSON.stringify({error: "Theme not found"}));
        return;
      }

      const essays = await getGitHubThemeUsage(theme);

      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({
        ok: true,
        theme,
        count: essays.length,
        essays
      }));
    } catch (error) {
      const statusCode =
        error.statusCode ||
        (error instanceof ValidationError ? 400 : 500);

      res.writeHead(statusCode, {"Content-Type": "application/json"});
      res.end(JSON.stringify({error: error.message}));
    }

    return;
  }

  if (
    req.method === "POST" &&
    req.url === "/api/essay-themes/rename"
  ) {
    try {
      const body = await readRequestBody(req, 64 * 1024);
      const data = JSON.parse(body);

      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new ValidationError("Invalid theme rename request");
      }

      const {oldTheme, newTheme, confirm} = data;

      if (
        typeof oldTheme !== "string" ||
        !oldTheme.trim() ||
        oldTheme.trim().length > 100
      ) {
        throw new ValidationError("A valid existing theme is required");
      }

      if (
        typeof newTheme !== "string" ||
        !newTheme.trim() ||
        newTheme.trim().length > 100
      ) {
        throw new ValidationError(
          "The new theme name must contain 1–100 characters"
        );
      }

      if (confirm !== true) {
        throw new ValidationError(
          "Theme renaming requires explicit confirmation"
        );
      }

      const cleanOldTheme = oldTheme.trim();
      const cleanNewTheme = newTheme.trim();

      if (cleanOldTheme === cleanNewTheme) {
        throw new ValidationError(
          "The new name must be different from the existing name"
        );
      }

      const result = await renameGitHubEssayTheme(
        cleanOldTheme,
        cleanNewTheme
      );

      console.log(
        "Essay theme renamed:",
        cleanOldTheme,
        "to",
        cleanNewTheme,
        "(updated",
        result.affectedCount,
        "essays)"
      );

      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({
        ok: true,
        oldTheme: cleanOldTheme,
        newTheme: cleanNewTheme,
        themes: result.themes,
        affectedCount: result.affectedCount,
        essays: result.affectedEssays,
        commit: result.commit
      }));
    } catch (error) {
      console.error("Essay theme rename error:", error.message);

      const statusCode =
        error.statusCode ||
        (
          error instanceof ValidationError ||
          error instanceof SyntaxError
            ? 400
            : 500
        );

      res.writeHead(statusCode, {"Content-Type": "application/json"});
      res.end(JSON.stringify({error: error.message}));
    }

    return;
  }

  if (
    req.method === "POST" &&
    req.url === "/api/essay-themes/delete"
  ) {
    try {
      const body = await readRequestBody(req, 64 * 1024);
      const data = JSON.parse(body);

      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new ValidationError("Invalid theme deletion request");
      }

      const theme = data.theme;

      if (
        typeof theme !== "string" ||
        !theme.trim() ||
        theme.trim().length > 100
      ) {
        throw new ValidationError("A valid theme is required");
      }

      if (data.confirm !== true) {
        throw new ValidationError("Theme deletion requires explicit confirmation");
      }

      const cleanTheme = theme.trim();
      const themesPath = "static/editor-data/essay-themes.json";
      const currentFile = await getGitHubFile(themesPath);
      const themes = JSON.parse(currentFile.content);

      if (!Array.isArray(themes)) {
        throw new Error("The existing essay themes file is not a valid array");
      }

      if (!themes.includes(cleanTheme)) {
        res.writeHead(404, {"Content-Type": "application/json"});
        res.end(JSON.stringify({error: "Theme not found"}));
        return;
      }

      const essays = await getGitHubThemeUsage(cleanTheme);
      const updatedThemes = themes.filter(item => item !== cleanTheme);

      const updated = await updateGitHubFile(
        themesPath,
        JSON.stringify(updatedThemes, null, 2) + "\n",
        currentFile.sha
      );

      console.log(
        "Essay theme removed:",
        cleanTheme,
        "(used by",
        essays.length,
        "essays)"
      );

      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({
        ok: true,
        theme: cleanTheme,
        themes: updatedThemes,
        affectedEssays: essays.length,
        essays,
        sha: updated.sha,
        commit: updated.commit
      }));
    } catch (error) {
      console.error("Essay theme deletion error:", error.message);

      const statusCode =
        error.statusCode ||
        (error instanceof ValidationError || error instanceof SyntaxError
          ? 400
          : 500);

      res.writeHead(statusCode, {"Content-Type": "application/json"});
      res.end(JSON.stringify({error: error.message}));
    }

    return;
  }

  if (
    (req.method === "GET" && req.url === "/api/essay-themes") ||
    (req.method === "POST" && req.url === "/api/essay-themes")
  ) {
    const themesPath = "static/editor-data/essay-themes.json";

    try {
      if (req.method === "GET") {
        const file = await getGitHubFile(themesPath);
        const themes = JSON.parse(file.content);

        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({
          ok: true,
          themes
        }));
        return;
      }

      const body = await readRequestBody(req, 64 * 1024);
      const data = JSON.parse(body);

      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new ValidationError("Invalid theme data");
      }

      const {theme} = data;

      if (
        typeof theme !== "string" ||
        !theme.trim() ||
        theme.trim().length > 100
      ) {
        throw new ValidationError(
          "A valid theme is required (maximum 100 characters)"
        );
      }

      const cleanTheme = theme.trim();
      const currentFile = await getGitHubFile(themesPath);
      const themes = JSON.parse(currentFile.content);

      if (!Array.isArray(themes)) {
        throw new Error("The existing essay themes file is not a valid array");
      }

      if (themes.includes(cleanTheme)) {
        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({
          ok: true,
          theme: cleanTheme,
          themes,
          unchanged: true
        }));
        return;
      }

      themes.push(cleanTheme);
      themes.sort((a, b) => a.localeCompare(b));

      const updated = await updateGitHubFile(
        themesPath,
        JSON.stringify(themes, null, 2) + "\n",
        currentFile.sha
      );

      console.log("Essay theme added:", cleanTheme);

      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({
        ok: true,
        theme: cleanTheme,
        themes,
        sha: updated.sha
      }));

    } catch (error) {
      console.error("Essay theme error:", error.message);

      const statusCode =
        error.statusCode ||
        (error instanceof ValidationError || error instanceof SyntaxError
          ? 400
          : 500);

      res.writeHead(statusCode, {"Content-Type": "application/json"});
      res.end(JSON.stringify({error: error.message}));
    }

    return;
  }

  if (req.method === "GET" && req.url === "/api/documents") {
    try {
      const githubDocuments = await listGitHubDocuments();
      const localDocuments = listLocalDocuments();
      const permalinkMap = listHugoPermalinks();

      const documentMap = new Map(
        githubDocuments.map(item => [item.path, item])
      );

      for (const item of localDocuments) {
        documentMap.set(item.path, item);
      }

      const allDocuments = [...documentMap.values()];

      const documents = allDocuments
        .map(item => ({
          ...item,
          permalink: permalinkMap.get(item.path) || null
        }));

      const missingPermalinks = allDocuments.filter(item => !permalinkMap.has(item.path)).length;

      if (missingPermalinks > 0) {
        console.warn(
          "Documents without Hugo permalinks:",
          missingPermalinks,
          allDocuments
            .filter(item => !permalinkMap.has(item.path))
            .map(item => item.path)
        );
      }

      console.log(
        "Documents listed:",
        documents.length,
        "(including",
        localDocuments.length,
        "local files)"
      );

      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({
        ok: true,
        documents
      }));
    } catch (error) {
      console.error("GitHub list error:", error.message);

      res.writeHead(500, {"Content-Type": "application/json"});
      res.end(JSON.stringify({error: error.message}));
    }

    return;
  }

  if (
    req.method === "GET" &&
    new URL(req.url, "http://localhost:1314").pathname === "/api/document"
  ) {
    const url = new URL(req.url, "http://localhost:1314");
    const path = url.searchParams.get("path");

    if (!isAllowedPath(path)) {
      res.writeHead(400, {"Content-Type": "application/json"});
      res.end(JSON.stringify({error: "Path is not allowed"}));
      return;
    }

    try {
      const localPath = nodePath.resolve(__dirname, "..", path);
      const contentRoot = nodePath.resolve(__dirname, "..", "content");

      if (
        localPath.startsWith(contentRoot + nodePath.sep) &&
        fs.existsSync(localPath)
      ) {
        const content = fs.readFileSync(localPath, "utf8");

        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({
          ok: true,
          path,
          sha: "LOCAL",
          content,
          connections: matter(content).data.connections || [],
          local: true
        }));
        return;
      }

      const file = await getGitHubFile(path);

      console.log("GitHub file read:", file.path);
      console.log("SHA:", file.sha);
      console.log("Content length:", file.content.length);

      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({
        ok: true,
        path: file.path,
        sha: file.sha,
        content: file.content,
        connections: matter(file.content).data.connections || []
      }));
    } catch (error) {
      console.error("GitHub error:", error.message);

      res.writeHead(500, {"Content-Type": "application/json"});
      res.end(JSON.stringify({error: error.message}));
    }

    return;
  }

  res.writeHead(404, {"Content-Type": "application/json"});
  res.end(JSON.stringify({error: "Not found"}));
});

server.listen(1314, "127.0.0.1", () => {
  console.log("Lilamaya editor API listening on http://127.0.0.1:1314");
});
