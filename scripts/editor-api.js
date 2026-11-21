const http = require("http");
const fs = require("fs");
const nodePath = require("path");
const matter = require("gray-matter");
const {execFileSync} = require("child_process");

const GITHUB_OWNER = "anuragjain75-gif";
const GITHUB_REPO = "anuragjain75-gif.github.io";
const GITHUB_BRANCH = "main";

// GitHub credentials are optional for local writing.
// Remote operations check credentials individually.
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

    if (match) {
      process.env.GITHUB_TOKEN = match[1];
      console.log("GitHub credential loaded from Git credential manager.");
    } else {
      console.warn("GitHub credentials unavailable. Local editing remains available.");
    }
  } catch (error) {
    console.warn("GitHub credentials unavailable. Local editing remains available.");
  }
}

function requireGitHubCredentials() {
  if (!process.env.GITHUB_TOKEN) {
    const error = new Error(
      "GitHub credentials are unavailable. Local editing remains available; configure Git credentials to use remote operations."
    );
    error.statusCode = 503;
    throw error;
  }
}

// Linux local storage: pin directories before using names relative to them.
const crypto = require("crypto");
const repositoryRoot = nodePath.resolve(__dirname, "..");
function storageError(statusCode, message) { return Object.assign(new Error(message), {statusCode}); }
function saveFailure(error, details) { error.saveFailure = details; return error; }
function sameInode(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function directory(relative, create = false) {
  if (fs.realpathSync(repositoryRoot) !== repositoryRoot) throw storageError(403, "Repository ancestors must not be symbolic links.");
  const parts = relative ? relative.split("/") : [];
  if (parts.some(p => !p || p === "." || p === ".." || /[\\\0]/.test(p))) throw storageError(403, "Unsafe directory path.");
  let fd = fs.openSync(repositoryRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    for (const part of parts) {
      const child = `/proc/self/fd/${fd}/${part}`;
      if (create) { try { fs.mkdirSync(child, {mode: 0o700}); } catch (e) { if (e.code !== "EEXIST") throw e; } }
      const next = fs.openSync(child, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      fs.closeSync(fd); fd = next;
    }
    return {fd, path: `/proc/self/fd/${fd}`, close() { fs.closeSync(fd); }};
  } catch (e) {
    fs.closeSync(fd);
    if (["ELOOP", "ENOTDIR"].includes(e.code)) throw storageError(403, "Symbolic links and non-directory ancestors are not allowed.");
    throw e;
  }
}
function snapshot(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const a = fs.fstatSync(fd);
    if (!a.isFile()) throw storageError(403, "Only regular files are allowed.");
    const bytes = fs.readFileSync(fd), b = fs.fstatSync(fd);
    if (!sameInode(a,b) || a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.ctimeMs !== b.ctimeMs) throw storageError(409, "Document changed during read.");
    const sha = "LOCAL:" + crypto.createHash("sha256").update(bytes).update(`:${b.dev}:${b.ino}:${b.mtimeMs}`).digest("hex");
    return {fd, bytes, stat: b, sha, close() { fs.closeSync(fd); }};
  } catch (e) { if (fd !== undefined) fs.closeSync(fd); if (e.code === "ELOOP") throw storageError(403, "Symbolic links are not allowed."); throw e; }
}
function ownedUnlink(file, identity) {
  try { if (!sameInode(fs.lstatSync(file),identity)) throw storageError(409, "Cleanup refused: file ownership changed."); fs.unlinkSync(file); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
}
function writeExclusive(file, data, mode = 0o600) {
  let fd, identity;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    identity = fs.fstatSync(fd); // Record ownership before writes can fail.
    fs.writeFileSync(fd, data); fs.fchmodSync(fd,mode & 0o777); fs.fsyncSync(fd); return identity;
  } catch (e) { if (identity) ownedUnlink(file,identity); if (e.code === "EEXIST") throw storageError(409,"Local file already exists."); throw e; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function createLocalFile(relative,data) {
  const dir = directory(nodePath.dirname(relative),true);
  try {
    const file = `${dir.path}/${nodePath.basename(relative)}`; writeExclusive(file,data);
    const s = snapshot(file); try { fs.fsyncSync(dir.fd); return {path:relative,sha:s.sha,commit:null,local:true}; } finally { s.close(); }
  } finally { dir.close(); }
}
function readLocalFile(relative) {
  const dir = directory(nodePath.dirname(relative));
  try {
    const name = nodePath.basename(relative);
    if (fs.existsSync(`${dir.path}/.${name}.save-lock`)) throw saveFailure(storageError(409,"A save or recovery is in progress; preserve your draft and follow the recovery procedure."),
      {kind:"recovery-conflict",code:"RECOVERY_LOCK",publication:"unknown",recovery:{required:true,lockRetained:true}});
    const s = snapshot(`${dir.path}/${name}`); try { return {content:s.bytes.toString("utf8"),sha:s.sha}; } finally { s.close(); }
  } finally { dir.close(); }
}
function saveLocalFile(relative, content, expectedSha, validateDependency = () => {}) {
  if (!/^LOCAL:[a-f0-9]{64}$/.test(expectedSha)) throw saveFailure(storageError(409,"A current local revision is required. Preserve your draft before reviewing the disk version."),
    {kind:"stale-conflict",code:"REVISION_REQUIRED",publication:"none",recovery:{required:false,lockRetained:false}});
  const dir = directory(nodePath.dirname(relative));
  const name=nodePath.basename(relative), file=`${dir.path}/${name}`, lock=`${dir.path}/.${name}.save-lock`;
  let lockCreated=false, lockFD, backupDir, source, temp, tempIdentity, recovery, displaced=false;
  let publishedDraft=false, backupId=null, failureDetails=null;
  try {
    try { fs.mkdirSync(lock,{mode:0o700}); lockCreated=true; } catch(e) { if(e.code==="EEXIST") throw storageError(409,"Another writer or recovery owns this document."); throw e; }
    lockFD=fs.openSync(lock,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
    source=snapshot(file);
    validateDependency();
    if(source.sha!==expectedSha) throw storageError(409,"Document changed since it was opened.");
    backupDir=directory(`backups/editor-autosave/${nodePath.dirname(relative)}`,true);
    if(fs.fstatSync(backupDir.fd).dev!==fs.fstatSync(dir.fd).dev) throw storageError(503,"Safe saves require backups on the same filesystem.");
    const stamp=new Date().toISOString().replace(/[:.]/g,"-");
    backupId=`${name}.${stamp}-${process.pid}.bak`;
    const backup=`${backupDir.path}/${backupId}`;
    fs.copyFileSync(`/proc/self/fd/${source.fd}`,backup,fs.constants.COPYFILE_EXCL);
    const backupIdentity=fs.lstatSync(backup), backupFD=fs.openSync(backup,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(backupFD); } finally { fs.closeSync(backupFD); }
    temp=`${dir.path}/.${name}.${process.pid}.${Date.now()}.tmp`;
    tempIdentity=writeExclusive(temp,content,source.stat.mode);
    const current=snapshot(file); try { if(current.sha!==expectedSha) throw storageError(409,"Document changed during save preparation."); } finally { current.close(); }
    // Keep the displaced inode so edits in the validation/replacement window
    // are recoverable. Publication never overwrites an independently created path.
    recovery=`/proc/self/fd/${lockFD}/original`;
    fs.renameSync(file,recovery); displaced=true;
    const moved=snapshot(recovery); let conflict;
    try { conflict=moved.sha!==expectedSha; } finally { moved.close(); }
    if(conflict) throw storageError(409,"Document changed before publication.");
    validateDependency();
    try { fs.linkSync(temp,file); publishedDraft=true; } catch(e) { if(e.code==="EEXIST") throw storageError(409,"Another writer created the document during save."); throw e; }
    const last=snapshot(recovery); try { conflict=last.sha!==expectedSha; } finally { last.close(); }
    if(!sameInode(fs.lstatSync(backup),backupIdentity)) throw storageError(409,"Backup ownership changed; original retained for recovery.");
    fs.renameSync(recovery,backup); displaced=false;
    fs.fsyncSync(backupDir.fd); fs.fsyncSync(dir.fd);
    const published=snapshot(file); let sha;
    try { if(!sameInode(published.stat,tempIdentity)) throw storageError(409,"Published document changed; original retained in backup."); sha=published.sha; } finally { published.close(); }
    if(conflict) throw storageError(409,"External edit detected in displaced original; preserved in newest backup.");
    try { validateDependency(); }
    catch(assetError) {
      // An asset changed in the publication window. Restore only our own
      // unchanged published inode; never overwrite an intervening writer.
      const check=snapshot(file);
      try { if(check.sha!==sha||!sameInode(check.stat,tempIdentity))throw assetError; }
      finally { check.close(); }
      ownedUnlink(file,tempIdentity);
      try { fs.linkSync(backup,file); publishedDraft=false; fs.fsyncSync(dir.fd); }
      catch(restoreError) { throw assetError; } // Existing recovery reporting preserves the backup.
      throw assetError;
    }
    try {
      const names=fs.readdirSync(backupDir.path).filter(n=>n.startsWith(`${name}.`)&&n.endsWith(".bak")).sort().reverse();
      for(const old of names.slice(30)) { const p=`${backupDir.path}/${old}`, identity=fs.lstatSync(p); if(!identity.isFile()||identity.isSymbolicLink()) throw storageError(403,"Unsafe backup entry; retention stopped."); ownedUnlink(p,identity); }
    } catch(e) { console.warn("Old backup cleanup warning:",e.message); }
    return sha;
  } catch(e) {
    if(displaced) {
      try { fs.linkSync(recovery,file); ownedUnlink(recovery,fs.lstatSync(recovery)); displaced=false; }
      catch(restoreError) { console.error("Original retained in .save-lock/original:",relative,restoreError.message); e.message+=" Original retained in .save-lock/original; manual recovery required."; }
    }
    const recoveryRequired=publishedDraft||displaced||(!lockCreated && e.statusCode===409);
    const kind=recoveryRequired?"recovery-conflict":e.statusCode===409?"stale-conflict":"failure";
    const details=failureDetails={kind,code:recoveryRequired?"RECOVERY_REVIEW_REQUIRED":e.statusCode===409?"LOCAL_REVISION_CONFLICT":"LOCAL_SAVE_FAILED",
      publication:publishedDraft?"occurred":"none",
      recovery:{required:recoveryRequired,lockRetained:displaced||(!lockCreated&&e.statusCode===409),
        ...(recoveryRequired&&backupId?{backupId}:{})}};
    if(!lockCreated&&e.statusCode===409)details.publication="unknown";
    // Error text is safe for browser display: never expose OS error paths.
    e.message=recoveryRequired?"Save not confirmed. Preserve your browser draft; inspect the disk version and indicated recovery data before further writes."
      :e.statusCode===409?"The document changed or another save could not safely proceed. This request did not publish your draft."
      :"The save failed before draft publication. Your browser draft must be preserved before retrying.";
    throw saveFailure(e,details);
  } finally {
    if(source) source.close();
    if(tempIdentity) { try { ownedUnlink(temp,tempIdentity); } catch(e) { console.error("Temporary cleanup refused:",e.message); } }
    if(lockFD!==undefined) fs.closeSync(lockFD);
    let lockCleanupFailed=false;
    if(lockCreated&&!displaced) {
      try { fs.rmdirSync(lock); }
      catch(e) {
        lockCleanupFailed=true;
        if(failureDetails){failureDetails.kind="recovery-conflict";failureDetails.recovery.required=true;failureDetails.recovery.lockRetained=true;}
        console.warn("Save lock retained:",e.message);
      }
    }
    if(backupDir) backupDir.close(); dir.close();
    if(lockCleanupFailed&&!failureDetails)throw saveFailure(storageError(500,"Draft publication completed but a save lock remains. Preserve your draft and follow the recovery procedure."),
      {kind:"recovery-conflict",code:"LOCK_CLEANUP_FAILED",publication:publishedDraft?"occurred":"unknown",recovery:{required:true,lockRetained:true,...(backupId?{backupId}:{})}});
  }
}
function denyRemoteMutation() { throw storageError(403,"Remote mutations are disabled in local-first mode."); }
function assertSafeHugoContent(relative="content") {
  let dir; try { dir=directory(relative); } catch(e) { if(e.code==="ENOENT") return; throw e; }
  try { for(const item of fs.readdirSync(dir.path,{withFileTypes:true})) { if(item.isSymbolicLink()) throw storageError(403,"Hugo content must not contain symbolic links."); if(item.isDirectory()) assertSafeHugoContent(`${relative}/${item.name}`); } }
  finally { dir.close(); }
}

function updateConnectionsFrontmatter(content, connections) {
  const parsed = matter(content);
  const signature=value=>JSON.stringify(value,(key,item)=>item&&typeof item==="object"&&!Array.isArray(item)
    ?Object.fromEntries(Object.keys(item).sort().map(name=>[name,item[name]])):item);
  if(Object.prototype.hasOwnProperty.call(parsed.data,"connections")&&signature(parsed.data.connections)===signature(connections)) return content;

  // Do not add empty Connections metadata to older documents.
  if (
    connections.length === 0 &&
    !Object.prototype.hasOwnProperty.call(parsed.data, "connections")
  ) {
    return content;
  }

  if (!content.startsWith("---")) {
    throw new Error("Document has no YAML frontmatter");
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);

  if (!match) {
    throw new Error("Could not locate YAML frontmatter");
  }

  const originalYaml = match[1];
  const newline=match[0].includes("\r\n")?"\r\n":"\n";
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
      (lines[end] === "" || /^[ \t]/.test(lines[end]) || /^-(?:[ \t]|$)/.test(lines[end]))
    ) {
      end++;
    }

    let blanks=0;
    for(let i=end-1;i>start&&!lines[i].trim();i--) blanks++;
    updatedLines = [...lines.slice(0,start),connectionsYaml,...Array(blanks).fill(""),...lines.slice(end)];
  }

  const updated = content.replace(
    match[0],
    () => `---${newline}${updatedLines.join("\n").replace(/\r?\n/g,newline)}${newline}---`
  );

  const validated = matter(updated);

  if (!Array.isArray(validated.data.connections)) {
    throw new Error("Updated connections field is invalid");
  }

  return updated;
}

function listHugoPermalinks() {
  assertSafeHugoContent();
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

  if(connections.length===0) return [];
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
  requireGitHubCredentials();
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
  denyRemoteMutation();
  requireGitHubCredentials();
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
  denyRemoteMutation();
  requireGitHubCredentials();
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
  denyRemoteMutation();
  requireGitHubCredentials();
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
  denyRemoteMutation();
  requireGitHubCredentials();
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

// Two independent local taxonomies reuse the same source-safe engine.
const LOCAL_THEME_PROFILES = Object.freeze({
  essays: Object.freeze({section:"essays",catalogPath:"static/editor-data/essay-themes.json",assignmentKey:"themes"}),
  fragments: Object.freeze({section:"fragments",catalogKey:"fragmentThemes",assignmentKey:"fragmentthemes"}),
  paintings: Object.freeze({section:"paintings",catalogKey:"paintingThemes",assignmentKey:"paintingthemes"})
});
const fragmentThemeTools = require('./lilamaya-fragment-themes.cjs');
const localThemeCatalogPath = 'data/lilamaya.yaml';
function readThemeSource(relative) {
  const dir=directory(nodePath.dirname(relative));
  try {
    const name=nodePath.basename(relative);
    if(fs.existsSync(`${dir.path}/.${name}.save-lock`))throw storageError(409,'A save or recovery owns a theme source; retry only after reviewing it.');
    const file=snapshot(`${dir.path}/${name}`);
    try {const content=file.bytes.toString('utf8');if(!Buffer.from(content,'utf8').equals(file.bytes))throw storageError(400,'Theme sources must be valid UTF-8');return {content,sha:file.sha};}finally{file.close();}
  }finally{dir.close();}
}
function readLocalThemeCatalog(profile) {
  const file=readThemeSource(profile.catalogPath||localThemeCatalogPath);
  const values=profile.catalogPath?JSON.parse(file.content):fragmentThemeTools.listInfo(file.content,profile.catalogKey,false).values;
  if(!Array.isArray(values)||values.some(v=>typeof v!=='string'||fragmentThemeTools.validName(v)!==v))throw storageError(400,'Invalid theme catalog');
  const keys=values.map(fragmentThemeTools.keyOf);
  if(new Set(keys).size!==keys.length)throw storageError(409,'Local theme definitions contain case-insensitive duplicates; review the catalog.');
  return {...file,values};
}
function rewriteThemeCatalog(profile,content,transform,add=[]) {
 if(!profile.catalogPath)return fragmentThemeTools.rewriteList(content,profile.catalogKey,transform,false,add);
 const values=JSON.parse(content),next=values.map(transform).filter(v=>v!==null);for(const value of add)if(!next.includes(value))next.push(value);
 if(new Set(next.map(v=>v.toLowerCase())).size!==next.length)throw storageError(409,'Duplicate theme catalog values');
 return JSON.stringify(next)===JSON.stringify(values)?content:JSON.stringify(next,null,2)+'\n';
}
function localThemeUsage(profile, theme, newTheme = null) {
  fragmentThemeTools.validName(theme);assertSafeHugoContent('content/'+profile.section);
  const index=localThemeIndex(profile),resolved=resolveLocalTheme(profile, theme,index);
  if(!index.themes.includes(resolved))throw storageError(404,'Theme not found');
  const documents=listLocalDocuments([profile.section]).sort((a,b)=>a.path.localeCompare(b.path));
  const files=documents.map(document=>{const file=readThemeSource(document.path),values=matter(file.content).data[profile.assignmentKey]||[];if(!Array.isArray(values))throw storageError(400,'Invalid theme assignments');return {...document,...file,values};});
  const catalog=readLocalThemeCatalog(profile);
  const revision=crypto.createHash('sha256').update(JSON.stringify({section:profile.section,theme:resolved,newTheme,catalog:catalog.sha,documents:files.map(f=>[f.path,f.sha])})).digest('hex');
  return {theme:resolved,index,catalog,files,revision,items:files.filter(f=>f.values.some(v=>v.toLowerCase()===resolved.toLowerCase())).map(f=>({path:f.path,title:f.title,sha:f.sha}))};
}
function withLocalThemeLock(action) {
  // Preserve the existing catalog-file lock name for old/new writer compatibility.
  const dir=directory('data');const lock=`${dir.path}/.fragment-theme-operation-lock`;let owned=false,identity;
  try{try{fs.mkdirSync(lock,{mode:0o700});identity=fs.lstatSync(lock);owned=true;}catch(e){if(e.code==='EEXIST')throw storageError(409,'Another local theme operation is in progress');throw e;}return action();}
  finally{try{if(owned){if(!sameInode(fs.lstatSync(lock),identity))throw storageError(409,"Local theme lock ownership changed; stop and review recovery data");fs.rmdirSync(lock);}}finally{dir.close();}}
}
function themeLabel(profile,value) { return profile.section==="essays"?value:fragmentThemeLabel(value); }
function addLocalTheme(profile, value) {
  const name=themeLabel(profile,fragmentThemeTools.validName(value));
  return withLocalThemeLock(()=>{
    const index=localThemeIndex(profile),theme=resolveLocalTheme(profile, name,index),catalog=readLocalThemeCatalog(profile);
    if(!catalog.values.some(v=>v.toLowerCase()===theme.toLowerCase())){
      const updated=rewriteThemeCatalog(profile,catalog.content,v=>v,[themeLabel(profile,theme)]);
      saveLocalFile(profile.catalogPath||localThemeCatalogPath,updated,catalog.sha);
    }
    return {theme,index:localThemeIndex(profile)};
  });
}
function mutateLocalTheme(profile, data,remove=false) {
  if(!data||typeof data!=='object'||Array.isArray(data)||data.confirm!==true)throw new ValidationError('Explicit theme confirmation is required');
  const old=fragmentThemeTools.validName(remove?data.theme:data.oldTheme),newName=remove?null:themeLabel(profile,fragmentThemeTools.validName(data.newTheme));
  return withLocalThemeLock(()=>{
    const usage=localThemeUsage(profile, old,newName);
    if(typeof data.revision!=='string'||data.revision!==usage.revision)throw storageError(409,'Theme usage changed; review it again before confirming');
    if(remove&&usage.items.length)throw storageError(409,'Assigned themes cannot be removed; existing assignments are protected');
    if(!remove&&newName===usage.theme)throw new ValidationError('The new name is identical to the current name');
    if(!remove&&newName.toLowerCase()!==usage.theme.toLowerCase()&&usage.index.groups.has(newName.toLowerCase()))throw storageError(409,'A theme with that name already exists');
    // The UI must explicitly warn/confirm an assigned term-name/URL change.
    if(!remove&&usage.items.length&&newName.toLowerCase()!==usage.theme.toLowerCase()&&data.approveUrlChange!==true)throw storageError(409,'Renaming an assigned theme may change its public URL; explicit URL-change approval is required');
    const changes=[];
    for(const file of usage.files){
      if(!file.values.some(v=>v.toLowerCase()===usage.theme.toLowerCase()))continue;
      const content=fragmentThemeTools.rewriteList(file.content,profile.assignmentKey,v=>v.toLowerCase()===usage.theme.toLowerCase()?newName:v,true);
      if(content!==file.content)changes.push({...file,updated:content});
    }
    const catalog=usage.catalog;let matched=false;
    let updatedCatalog=rewriteThemeCatalog(profile,catalog.content,v=>{if(v.toLowerCase()!==usage.theme.toLowerCase())return v;matched=true;return remove?null:newName;});
    if(!remove&&!matched)updatedCatalog=rewriteThemeCatalog(profile,updatedCatalog,v=>v,[newName]);
    const completed=[],attempted=[];
    try{
      for(const file of changes){attempted.push(file.path);if(readThemeSource(file.path).sha!==file.sha)throw storageError(409,'Document changed since review');saveLocalFile(file.path,file.updated,file.sha);completed.push(file.path);}
      // Refuse a concurrent new/changed document that was outside this review.
      const names=listLocalDocuments([profile.section]).map(f=>f.path).sort();if(JSON.stringify(names)!==JSON.stringify(usage.files.map(f=>f.path).sort()))throw storageError(409,'Document inventory changed during rename');
      for(const file of usage.files){const current=readThemeSource(file.path);if(completed.includes(file.path)){if(current.content!==changes.find(x=>x.path===file.path).updated)throw storageError(409,'Renamed document changed concurrently');}else if(current.sha!==file.sha)throw storageError(409,'Another document changed during rename');}
      if(updatedCatalog!==catalog.content)saveLocalFile(profile.catalogPath||localThemeCatalogPath,updatedCatalog,catalog.sha);
    }catch(error){error.completedThemePaths=completed;error.attemptedThemePaths=attempted;if(profile.section==="fragments"){error.completedFragmentPaths=completed;error.attemptedFragmentPaths=attempted;}if(attempted.length)error.message+=' Theme operation not confirmed. Stop and review attempted files: '+attempted.join(', ')+'. Confirmed updates: '+(completed.join(', ')||'none')+'. Preserve local save backups before retrying.';throw error;}
    return {ok:true,local:true,themes:localThemeIndex(profile).themes,theme:newName||usage.theme,label:newName?themeLabel(profile,newName):themeLabel(profile,usage.theme),affectedCount:completed.length,[profile.section]:usage.items,commit:null};
  });
}

// Labels are presentation only; existing stored local-theme spellings remain identities.
function fragmentThemeLabel(value) {
  const [first, ...rest] = Array.from(value);
  return first ? first.toUpperCase() + rest.join("") : value;
}
function localThemeIndex(profile) {
  const groups = new Map();
  for (const document of listLocalDocuments([profile.section])) {
    const values = matter(readLocalFile(document.path).content).data[profile.assignmentKey] ?? [];
    if (!Array.isArray(values) || values.some(value => typeof value !== "string" || !value.trim() || value.trim().length > 100)) {
      throw new ValidationError("Local themes must be a list of nonempty names of at most 100 characters");
    }
    for (const value of values) {
      const name = value.trim(), key = name.toLowerCase();
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(name);
    }
  }
  // Reuse the existing independent definitions, retaining stored assignment spellings.
  for (const name of readLocalThemeCatalog(profile).values) {
    const key=name.toLowerCase(); if (!groups.has(key)) groups.set(key,new Set([name]));
  }
  const themes = [], conflicts = [];
  for (const variants of groups.values()) {
    if (variants.size > 1) conflicts.push({label:fragmentThemeLabel([...variants][0]), variants:[...variants].sort()});
    else themes.push([...variants][0]);
  }
  themes.sort((a,b) => a.localeCompare(b));
  return {groups, themes, conflicts, themeOptions:themes.map(value => ({value,label:themeLabel(profile,value)}))};
}
function resolveLocalTheme(profile, name, index) {
  const variants = index.groups.get(name.toLowerCase());
  if (variants?.size > 1) throw storageError(409, "Theme has conflicting stored case variants; review them before selecting it.");
  return variants?.size ? [...variants][0] : themeLabel(profile,name);
}

// Existing Fragment contracts remain wrappers around the shared typed engine.
function fragmentThemeIndex() { return localThemeIndex(LOCAL_THEME_PROFILES.fragments); }
function resolveFragmentTheme(name,index) { return resolveLocalTheme(LOCAL_THEME_PROFILES.fragments,name,index); }
function addFragmentTheme(value) { return addLocalTheme(LOCAL_THEME_PROFILES.fragments,value); }
function fragmentThemeUsage(theme,newTheme=null) { const usage=localThemeUsage(LOCAL_THEME_PROFILES.fragments,theme,newTheme); return {...usage,fragments:usage.items}; }
function mutateFragmentTheme(data,remove=false) { return mutateLocalTheme(LOCAL_THEME_PROFILES.fragments,data,remove); }


// Read-only metadata projection from the same loaded source/revision.
function readDocumentMetadata(content, documentPath) {
  const type=documentPath.split('/')[1], themeKey={essays:'themes',fragments:'fragmentthemes',paintings:'paintingthemes'}[type];
  if(!themeKey){
    if(!['people','works','ideas','traditions','places','journeys'].includes(type))return null;
    const data=matter(content).data;return {type,fields:{title:typeof data.title==='string'?data.title:'Untitled'}};
  }
  const data=matter(content).data,fields={};
  const keys=['title','date','description','draft',themeKey,...(type!=='fragments'?['hero']:[]),...(type==='paintings'?['artist','year']:[])];
  for(const key of keys)if(Object.prototype.hasOwnProperty.call(data,key))fields[key]=data[key];
  if(Object.prototype.hasOwnProperty.call(fields,'date')) {
    const header=content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const raw=header?.[1].match(/^date:[ \t]*("[^"\r\n]*"|'[^'\r\n]*'|[^#\r\n]*)/m)?.[1].trim();
    if(raw) {
      try {fields.date=raw.startsWith('"')?JSON.parse(raw):raw.startsWith("'")?raw.slice(1,-1):raw;}
      catch {fields.date=raw;}
    }
  }
  const result={type,fields};
  if(type!=='fragments'&&typeof fields.hero==='string'){
    try{result.heroAsset=heroAssetSnapshot(documentPath,fields.hero);}
    catch(error){result.heroError='The explicit hero resource is missing or invalid. Replace, remove or restore it before saving.';}
  }
  return result;
}

function listLocalDocuments(sections = ["essays","fragments","paintings","people","works","ideas","traditions","places","journeys"]) {
  const documents=[];
  function scan(relative) {
    let dir; try { dir=directory(relative); } catch(e) { if(e.code==="ENOENT") return; throw e; }
    try {
      for(const item of fs.readdirSync(dir.path,{withFileTypes:true})) {
        const child=`${relative}/${item.name}`;
        if(item.isSymbolicLink()) continue;
        if(item.isDirectory()) { scan(child); continue; }
        if(!item.isFile()||item.name==="_index.md"||!isAllowedPath(child)) continue;
        const file=snapshot(`${dir.path}/${item.name}`);
        try { const match=file.bytes.toString("utf8").match(/^title:\s*["']?(.+?)["']?\s*$/m); documents.push({path:child,title:match?match[1]:child}); }
        finally { file.close(); }
      }
    } finally { dir.close(); }
  }
  for(const section of sections) scan(`content/${section}`);
  return documents;
}

async function listGitHubDocuments() {
  requireGitHubCredentials();
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
  requireGitHubCredentials();
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
    () => updatedFrontmatter
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
  requireGitHubCredentials();
  const blob = await githubApiRequest(`/git/blobs/${sha}`);

  if (blob.encoding !== "base64" || typeof blob.content !== "string") {
    throw new Error("GitHub returned an unsupported blob encoding");
  }

  return Buffer.from(blob.content, "base64").toString("utf8");
}


async function renameGitHubEssayTheme(oldTheme, newTheme) {
  denyRemoteMutation();
  requireGitHubCredentials();
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
  requireGitHubCredentials();
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

const metadataPatch = require('./lilamaya-metadata-patch.cjs');
const metadataURL = require('./lilamaya-metadata-url.cjs');
function metadataSourceSnapshot() {
  const files=new Map(),revisions=new Map();
  const read=(relative)=>{
    const parent=nodePath.dirname(relative),dir=directory(parent==='.'?'':parent);
    try{const file=snapshot(`${dir.path}/${nodePath.basename(relative)}`);try{const bytes=file.bytes;if(!Buffer.from(bytes.toString('utf8'),'utf8').equals(bytes))throw storageError(400,'URL source is not valid UTF-8');files.set(relative,bytes);revisions.set(relative,file.sha);}finally{file.close();}}finally{dir.close();}
  };
  const walk=(relative)=>{const dir=directory(relative);try{for(const item of fs.readdirSync(dir.path,{withFileTypes:true})){if(item.isSymbolicLink())throw storageError(403,'Symbolic links are not supported in URL validation');const child=relative+'/'+item.name;if(item.isDirectory())walk(child);else if(item.isFile()&&item.name.endsWith('.md'))read(child);else if(item.isFile()&&/\.(html|org|rst|adoc)$/i.test(item.name))throw storageError(422,'Additional content formats require separate URL verification');}}finally{dir.close();}};
  if(fs.existsSync(nodePath.join(repositoryRoot,'config')))throw storageError(422,'Additional Hugo configuration requires separate verification');
  read('hugo.toml');walk('content');
  for(const name of ['introduction','poetry','invocation'])read('layouts/shortcodes/'+name+'.html');
  return {files,revisions,identity:JSON.stringify([...revisions].sort((a,b)=>a[0].localeCompare(b[0])))};
}
// Reuse pinned-directory reads and signature validation; never follow arbitrary resource URLs.
function heroAssetSnapshot(documentPath, reference, expected) {
  metadataPatch.validHero(reference);
  if(typeof reference!=='string'||!/^content\/(essays|paintings)\/[a-z0-9-]+\/index\.md$/.test(documentPath))throw storageError(400,'Hero images require an Essay or Painting bundle');
  const path=nodePath.posix.dirname(documentPath)+'/'+reference;
  const dir=directory(nodePath.posix.dirname(path));
  try{const asset=snapshot(dir.path+'/'+nodePath.posix.basename(path));try{
    validateImageContent(path,asset.bytes.toString('base64'));
    if(expected&& (expected.path!==path||expected.sha!==asset.sha))throw storageError(409,'The reviewed hero image changed. Preserve the draft and review the image again.');
    return {path,sha:asset.sha};
  }finally{asset.close();}}finally{dir.close();}
}
function validateHeroDependency(path,content,intent){
  if(!/^content\/(essays|paintings)\//.test(path))return;
  if(!content.startsWith('---'))return;
  const data=metadataPatch.parse(content).data;
  if(!Object.hasOwn(data,'hero'))return;
  metadataPatch.validHero(data.hero);
  if(data.hero!==false){
    if(!intent?.heroAsset||typeof intent.heroAsset.sha!=='string')throw storageError(400,'A reviewed hero asset revision is required');
    heroAssetSnapshot(path,data.hero,intent.heroAsset);
  }
}
function validateMetadataSave(path,content,revision,intent) {
  const type=path.split('/')[1];if(!Object.hasOwn(metadataPatch.FIELDS,type))return content;
  try{
    const current=readLocalFile(path);if(current.sha!==revision)throw storageError(409,'Document changed since it was opened. Preserve your draft.');
    const changes=intent?.changes||{};
    if(intent&&(!intent.changes||Array.isArray(intent.changes)||typeof intent.changes!=='object'))throw storageError(400,'Invalid metadata intent');
    if(Object.keys(changes).length){
      if(typeof intent.baseFrontmatter!=='string')throw storageError(400,'Original metadata source is required');
      const proposed=metadataPatch.frontmatter(content),base=metadataPatch.parse(intent.baseFrontmatter),disk=metadataPatch.parse(current.content);
      const ignore=new Set([...Object.keys(changes),'introduction','connections']);
      const other=data=>Object.fromEntries(Object.entries(data).filter(([k])=>!ignore.has(k)));
      if(metadataPatch.stable(other(base.data))!==metadataPatch.stable(other(disk.data)))throw storageError(409,'Unrelated metadata changed; preserve your complete draft');
      const patched=metadataPatch.patchMetadata(intent.baseFrontmatter+proposed.body,type,changes);
      if(patched!==content)throw storageError(400,'Submitted source does not match the reviewed metadata edits');
      const theme=metadataPatch.THEMES[type];
      if(theme&&Object.hasOwn(changes,theme)){
        const existing=disk.data[theme]||[];
        const known=type==='essays'?(()=>{const dir=directory('static/editor-data');try{const f=snapshot(dir.path+'/essay-themes.json');try{return JSON.parse(f.bytes.toString('utf8'));}finally{f.close();}}finally{dir.close();}})():localThemeIndex(LOCAL_THEME_PROFILES[type]).themes;
        if(changes[theme].some(value=>!known.includes(value)&&!existing.includes(value)))throw storageError(422,'A selected theme is unavailable in this content type; review the assignments');
      }
    }
    if(['essays','paintings'].includes(type)&&(current.content.startsWith('---')||content.startsWith('---'))&&!Object.hasOwn(changes,'hero')&&metadataPatch.stable(metadataPatch.parse(current.content).data.hero)!==metadataPatch.stable(metadataPatch.parse(content).data.hero))throw storageError(400,'Hero changes require an explicit reviewed metadata intent');
    validateHeroDependency(path,content,intent);
    if(current.content===content)return content;
    let before,after;try{before=metadataPatch.frontmatter(current.content);after=metadataPatch.frontmatter(content);}catch(error){if(!Object.keys(changes).length&&!current.content.startsWith('---')&&!content.startsWith('---'))return content;throw error;}
    if(before.source!==after.source&&metadataPatch.stable(metadataPatch.urlFields(current.content))!==metadataPatch.stable(metadataPatch.urlFields(content))){
      const context=metadataSourceSnapshot();if(context.revisions.get(path)!==revision)throw storageError(409,'Document changed during URL validation');
      metadataURL.assertStableURL(context.files,path,content,intent?.expectedPermalink);
      if(metadataSourceSnapshot().identity!==context.identity)throw storageError(409,'Hugo content or configuration changed during URL validation; preserve your draft');
    }
    return content;
  }catch(error){error.statusCode=error.statusCode||400;error.saveFailure={kind:error.statusCode===409?'stale-conflict':'failure',code:'METADATA_REJECTED',publication:'none',recovery:{required:false,lockRetained:false}};throw error;}
}

// Derived cards never determine manuscript Save success. Jobs are serialized
// per document, and every worker receives only a minimal noncredential environment.
const socialJobs=new Map();
function socialCardJob(path,revision,check=false){
  if(!/^content\/(essays|paintings)\/[a-z0-9-]+\/index\.md$/.test(path))return Promise.resolve(null);
  const perform=()=>new Promise(resolve=>{
    let current;
    try{current=readLocalFile(path);if(current.sha!==revision)throw Error('stale');}
    catch{resolve({status:'failed',message:'The saved manuscript changed; review it before retrying the social card.',revision});return;}
    const sourceHash=crypto.createHash('sha256').update(current.content).digest('hex');
    const args=[nodePath.join(repositoryRoot,'scripts/social_cards.py'),'--document',path,'--source-sha',sourceHash,...(check?['--check']:[])];
    require('child_process').execFile(nodePath.join(repositoryRoot,'.venv/bin/python3'),args,{cwd:repositoryRoot,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',PYTHONDONTWRITEBYTECODE:'1',HOME:nodePath.join(repositoryRoot,'backups/editor-derived')},timeout:30000,maxBuffer:1024*1024},(error,stdout)=>{
      let result;try{result=JSON.parse(stdout);if(!['updated','current','stale','failed'].includes(result.status)||result.sourceHash!==sourceHash)throw Error('invalid');}
      catch{result={status:'failed',message:'The manuscript is saved, but the social-card update did not complete. Retry Social Card is available.'};}
      resolve({...result,revision});
    });
  });
  const failed=()=>({status:'failed',message:'The manuscript is saved, but the social-card update failed. Retry Social Card is available.',revision});
  if(check)return perform().catch(failed);
  const existing=socialJobs.get(path);
  if(existing?.revision===revision)return existing.promise;
  const promise=(existing?existing.promise.catch(()=>{}):Promise.resolve()).then(perform).catch(failed);
  const job={revision,promise};socialJobs.set(path,job);promise.finally(()=>{if(socialJobs.get(path)===job)socialJobs.delete(path);});return promise;
}

// One shared, local-only recovery service. Preparation never changes content.
const deletion = require('./editor-delete.js').createDeleteService({directory,snapshot,writeExclusive,
  busy:path=>socialJobs.has(path),
  incoming:path=>{
    const items=[];let complete=true;
    try{
      const permalink=listHugoPermalinks().get(path);
      if(!permalink)return {items,complete:false};
      for(const item of listLocalDocuments()){
        if(item.path===path)continue;
        try{const data=matter(readLocalFile(item.path).content).data;
          if(Array.isArray(data.connections)&&data.connections.some(link=>link?.target===permalink))items.push({path:item.path,title:item.title});
        }catch{complete=false;}
      }
    }catch{complete=false;}
    return {items,complete,limitation:'Only stored connections are checked. Body links, external references and shared assets are not exhaustively checked or changed.'};
  }
});
function authorizeDeletion(req){
  if(!['127.0.0.1:1314','localhost:1314'].includes(req.headers.host)||req.headers.origin!=='http://localhost:1313'||
    !/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw storageError(403,'Deletion requires a JSON request from the local Writing Desk.');
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

  if(req.method==='POST'&&['/api/delete-entry/prepare','/api/delete-entry/confirm'].includes(req.url)){
    try{
      authorizeDeletion(req);
      const request=JSON.parse(await readRequestBody(req,16384));
      let result;
      if(req.url.endsWith('/prepare')){
        require('./editor-delete.js').entryPath(request.path);
        const loaded=readLocalFile(request.path);
        result={ok:true,review:deletion.prepare(request.path,request.sha,matter(loaded.content).data.title)};
      }else result=deletion.execute(request);
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result));
    }catch(error){
      res.writeHead(error.statusCode||409,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({ok:false,error:error.deleteOutcome==='uncertain'?'Recovery outcome is uncertain. Export your draft and inspect the recovery record before further writes.':error.message,
        outcome:error.deleteOutcome||'unchanged',...(error.recoveryId?{recoveryId:error.recoveryId}:{})}));
    }
    return;
  }

  if(req.method==='POST'&&req.url==='/api/social-card/retry'){
    try{
      const {path,sha}=JSON.parse(await readRequestBody(req,8192));
      if(typeof path!=='string'||!/^content\/(essays|paintings)\/[a-z0-9-]+\/index\.md$/.test(path)||typeof sha!=='string')throw storageError(400,'An Essay or Painting and its current local revision are required');
      const current=readLocalFile(path);if(current.sha!==sha)throw storageError(409,'The saved manuscript changed; preserve the current draft before reviewing disk');
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,socialCard:await socialCardJob(path,sha)}));
    }catch(error){res.writeHead(error.statusCode||400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Social-card retry was rejected. The manuscript was not changed.'}));}
    return;
  }

  if (req.method === "POST" && req.url === "/api/save") {
    try {
      const body = await readRequestBody(req, 5 * 1024 * 1024);
      let {path, content, sha, connections, metadata} = JSON.parse(body);

        if (
          typeof path !== "string" ||
          typeof content !== "string" ||
          typeof sha !== "string"
        ) {
          throw storageError(400,"path, content, and sha are required");
        }

        if (!isAllowedPath(path)) {
          throw new Error("Path is not allowed");
        }

        if(sha==='LOCAL'||sha.startsWith('LOCAL:'))content=validateMetadataSave(path,content,sha,metadata);

        // Update only the connections field in the Markdown frontmatter.
        if (Array.isArray(connections)) {
          const currentPermalink = connections.length?listHugoPermalinks().get(path):null;
          const cleanConnections = validateConnections(
            connections,
            currentPermalink
          );

          content = updateConnectionsFrontmatter(content, cleanConnections);
        }

        if (sha === "LOCAL" || sha.startsWith("LOCAL:")) {
          const revision = saveLocalFile(path, content, sha, () => validateHeroDependency(path,content,metadata));
          res.writeHead(200, {"Content-Type": "application/json"});
          const socialCard=await socialCardJob(path,revision);
          res.end(JSON.stringify({ok:true,path,sha:revision,local:true,...(socialCard?{socialCard}:{})}));
          return;
        }
        denyRemoteMutation();

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
        res.end(JSON.stringify({
          error:error.saveFailure?error.message:"The save was rejected before publication. Preserve your draft and check the request or local document.",
          save:error.saveFailure||{kind:statusCode===409?"stale-conflict":"failure",code:"SAVE_REJECTED",publication:"none",recovery:{required:false,lockRetained:false}}
        }));
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
        /^content\/(essays|fragments|paintings)\/[a-z0-9-]+\/hero\.(jpg|jpeg|png|webp)$/i;

      const allowedInlinePath =
        /^content\/(essays|fragments|paintings)\/[a-z0-9-]+\/images\/[a-z0-9][a-z0-9_-]{0,79}\.(jpg|jpeg|png|webp)$/i;

      const allowedStandalonePath = /^static\/images\/fragments\/([a-z0-9-]+)\/[a-z0-9][a-z0-9_-]{0,79}\.(jpg|jpeg|png|webp)$/i;
      if (!allowedHeroPath.test(path) && !allowedInlinePath.test(path) && !allowedStandalonePath.test(path)) {
        throw new ValidationError("Image path is not allowed");
      }

      if (local !== undefined && typeof local !== "boolean") {
        throw new ValidationError("Invalid local upload flag");
      }

      if (!/^[A-Za-z0-9+/=\r\n]+$/.test(content)) {
        throw new ValidationError("Invalid image data");
      }

      // Require the owning document, and retain the pinned-directory/symlink checks.
      const standalone = path.match(allowedStandalonePath);
      const owner = standalone ? `content/fragments/${standalone[1]}.md`
        : path.replace(/\/(?:images\/)?[^/]+$/, "/index.md");
      const ownerDir = directory(nodePath.dirname(owner));
      const ownerLock=`${ownerDir.path}/.${nodePath.basename(owner)}.save-lock`;
      let uploadLock,uploaded;
      try {
        try{fs.mkdirSync(ownerLock,{mode:0o700});uploadLock=fs.lstatSync(ownerLock);}
        catch(error){if(error.code==='EEXIST')throw storageError(409,'Another save, deletion or recovery owns this document.');throw error;}
        const current=snapshot(`${ownerDir.path}/${nodePath.basename(owner)}`);current.close();
        validateImageContent(path,content);
        if(local===false)denyRemoteMutation();
        uploaded=createLocalFile(path,Buffer.from(content.replace(/[\r\n]/g,""),"base64"));
      } finally {
        try{if(uploadLock&&sameInode(fs.lstatSync(ownerLock),uploadLock))fs.rmdirSync(ownerLock);}
        finally{ownerDir.close();}
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

  if (req.method === "POST" && ["/api/new-essay", "/api/new-fragment", "/api/new-painting"].includes(req.url)) {
    const section = {"/api/new-essay": "essays", "/api/new-fragment": "fragments", "/api/new-painting": "paintings"}[req.url];
    try {
      const body = await readRequestBody(req, 1024 * 1024);
      const {title, introduction, themes, date, artist, year} = JSON.parse(body);
      if (section === "paintings" && (typeof artist !== "string" || !artist.trim() || artist.trim().length > 200 || typeof year !== "string" || !/^\d{4}$/.test(year))) {
        throw new ValidationError("A painting requires an artist and a four-digit year");
      }

      if (
        typeof title !== "string" ||
        !title.trim() ||
        title.trim().length > 200
      ) {
        throw new ValidationError("A valid title is required (maximum 200 characters)");
      }

      const cleanTitle = title.trim();
      const cleanIntroduction =
        section !== "fragments" && typeof introduction === "string" ? introduction.trim() : "";

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

      if (section === "fragments" || section === "paintings") {
        const profile=LOCAL_THEME_PROFILES[section],index=localThemeIndex(profile),seen=new Set();
        const normalized = cleanThemes.map(name => resolveLocalTheme(profile,name,index))
          .filter(name => { const key=name.toLowerCase(); if(seen.has(key)) return false; seen.add(key); return true; });
        cleanThemes.splice(0, cleanThemes.length, ...normalized);
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

      const markdownPath = `content/${section}/${slug}/index.md`;

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
        frontMatter += `${{essays: "themes", fragments: "fragmentthemes", paintings: "paintingthemes"}[section]}:\n`;
        for (const theme of cleanThemes) {
          frontMatter += `  - ${JSON.stringify(theme)}\n`;
        }
      }

      if (section === "paintings") {
        frontMatter += `artist: ${JSON.stringify(artist.trim())}\nyear: ${JSON.stringify(year)}\n`;
      }
      frontMatter += "---\n\n";

      if (cleanIntroduction) {
        frontMatter += "{{< introduction >}}\n\n";
      }

      const created = createLocalFile(markdownPath,frontMatter);

      res.writeHead(201, {"Content-Type": "application/json"});
      res.end(JSON.stringify({
        ok: true,
        path: created.path,
        sha: created.sha,
        commit: created.commit,
        local: true,
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
      if (requestUrl.searchParams.has("local") && requestUrl.searchParams.get("local") !== "1") denyRemoteMutation();
      const localMode = true;
      const created = createLocalFile(markdownPath,content);

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


  if ((req.method==='GET'&&new URL(req.url,'http://localhost:1314').pathname==='/api/essay-theme-usage')||(['GET','POST'].includes(req.method)&&['/api/essay-themes','/api/essay-themes/rename','/api/essay-themes/delete'].includes(req.url))) {
    try {
      const profile=LOCAL_THEME_PROFILES.essays;
      let result;
      if(req.method==='GET'&&req.url.startsWith('/api/essay-theme-usage')){
        const url=new URL(req.url,'http://localhost:1314'),next=url.searchParams.get('newTheme'),usage=localThemeUsage(profile,url.searchParams.get('theme'),next===null?null:themeLabel(profile,fragmentThemeTools.validName(next)));result={ok:true,theme:usage.theme,count:usage.items.length,essays:usage.items,revision:usage.revision};
      }else if(req.method==='POST'&&req.url!=='/api/essay-themes')result=mutateLocalTheme(profile,JSON.parse(await readRequestBody(req,64*1024)),req.url.endsWith('/delete'));
      else{
        let index=localThemeIndex(profile),theme;
        if(req.method==='POST'){const added=addLocalTheme(profile,JSON.parse(await readRequestBody(req,64*1024)).theme);index=added.index;theme=added.theme;}
        result={ok:true,themes:index.themes,themeOptions:index.themeOptions,conflicts:index.conflicts,...(theme===undefined?{}:{theme,label:themeLabel(profile,theme),local:true,pending:false})};
      }
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
    }catch(error){res.writeHead(error.statusCode||400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message,...(error.completedThemePaths?{completedThemePaths:error.completedThemePaths}:{}),...(error.attemptedThemePaths?{attemptedThemePaths:error.attemptedThemePaths}:{}),...(error.saveFailure?{save:error.saveFailure}:{})}));}
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
    res.writeHead(409, {"Content-Type": "application/json"});
    res.end(JSON.stringify({error: "Theme renaming is temporarily unavailable in local-first mode."}));
    return;

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
    res.writeHead(409, {"Content-Type": "application/json"});
    res.end(JSON.stringify({error: "Theme deletion is temporarily unavailable in local-first mode."}));
    return;

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

  if (req.method === "GET" && new URL(req.url,"http://localhost:1314").pathname === "/api/painting-theme-usage") {
    try {
      const url=new URL(req.url,"http://localhost:1314"),next=url.searchParams.get("newTheme");
      const usage=localThemeUsage(LOCAL_THEME_PROFILES.paintings,url.searchParams.get("theme"),next===null?null:fragmentThemeLabel(fragmentThemeTools.validName(next)));
      res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:true,theme:usage.theme,count:usage.items.length,paintings:usage.items,revision:usage.revision}));
    } catch(error) {res.writeHead(error.statusCode||400,{"Content-Type":"application/json"});res.end(JSON.stringify({error:error.message}));}
    return;
  }
  if (req.method === "POST" && ["/api/painting-themes/rename","/api/painting-themes/delete"].includes(req.url)) {
    try {
      const data=JSON.parse(await readRequestBody(req,64*1024)),result=mutateLocalTheme(LOCAL_THEME_PROFILES.paintings,data,req.url.endsWith("/delete"));
      res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(result));
    } catch(error) {res.writeHead(error.statusCode||400,{"Content-Type":"application/json"});res.end(JSON.stringify({error:error.message,...(error.completedThemePaths?{completedPaintingPaths:error.completedThemePaths}:{}),...(error.attemptedThemePaths?{attemptedPaintingPaths:error.attemptedThemePaths}:{}),...(error.saveFailure?{save:error.saveFailure}:{})}));}
    return;
  }
  if (["GET","POST"].includes(req.method) && req.url === "/api/painting-themes") {
    try {
      let index=localThemeIndex(LOCAL_THEME_PROFILES.paintings),theme;
      if(req.method==="POST") {const data=JSON.parse(await readRequestBody(req,64*1024));if(!data||typeof data!=="object"||Array.isArray(data))throw new ValidationError("Invalid Painting theme request");const added=addLocalTheme(LOCAL_THEME_PROFILES.paintings,data.theme);index=added.index;theme=added.theme;}
      res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:true,themes:index.themes,themeOptions:index.themeOptions,conflicts:index.conflicts,...(theme===undefined?{}:{theme,label:fragmentThemeLabel(theme),local:true,pending:false})}));
    }catch(error){res.writeHead(error.statusCode||400,{"Content-Type":"application/json"});res.end(JSON.stringify({error:error.message,...(error.saveFailure?{save:error.saveFailure}:{})}));}
    return;
  }

  if (req.method === "GET" && new URL(req.url,"http://localhost:1314").pathname === "/api/fragment-theme-usage") {
    try {
      const url=new URL(req.url,"http://localhost:1314"),next=url.searchParams.get("newTheme");
      const usage=fragmentThemeUsage(url.searchParams.get("theme"),next===null?null:fragmentThemeLabel(fragmentThemeTools.validName(next)));
      res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:true,theme:usage.theme,count:usage.fragments.length,fragments:usage.fragments,revision:usage.revision}));
    } catch(error) {res.writeHead(error.statusCode||400,{"Content-Type":"application/json"});res.end(JSON.stringify({error:error.message}));}
    return;
  }
  if (req.method === "POST" && ["/api/fragment-themes/rename","/api/fragment-themes/delete"].includes(req.url)) {
    try {
      const data=JSON.parse(await readRequestBody(req,64*1024));const result=mutateFragmentTheme(data,req.url.endsWith("/delete"));
      res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(result));
    } catch(error) {res.writeHead(error.statusCode||400,{"Content-Type":"application/json"});res.end(JSON.stringify({error:error.message,...(error.completedFragmentPaths?{completedFragmentPaths:error.completedFragmentPaths}: {}),...(error.attemptedFragmentPaths?{attemptedFragmentPaths:error.attemptedFragmentPaths}: {}),...(error.saveFailure?{save:error.saveFailure}: {})}));}
    return;
  }

  if (["GET", "POST"].includes(req.method) && req.url === "/api/fragment-themes") {
    try {
      // Hugo's existing Fragment taxonomy is authored in fragment frontmatter.
      // Do not read or mutate the separate Essay theme registry.
      let index = fragmentThemeIndex();
      let theme;
      if (req.method === "POST") {
        const data = JSON.parse(await readRequestBody(req, 64 * 1024));
        if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.theme !== "string" || !data.theme.trim() || data.theme.trim().length > 100) {
          throw new ValidationError("A valid Fragment theme is required (maximum 100 characters)");
        }
        const added=addFragmentTheme(data.theme); theme=added.theme; index=added.index;
      }
      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({ok: true, themes:index.themes, themeOptions:index.themeOptions, conflicts:index.conflicts,
        ...(theme === undefined ? {} : {theme, label:fragmentThemeLabel(theme), pending:false, local:true})}));
      // Definitions persist only in existing data/lilamaya.yaml.fragmentThemes.
      // Adding a definition does not rewrite any manuscript or Essay collection.
    } catch (error) {
      res.writeHead(error.statusCode || (error instanceof ValidationError || error instanceof SyntaxError ? 400 : 500), {"Content-Type": "application/json"});
      res.end(JSON.stringify({error: error.message, ...(error.saveFailure ? {save:error.saveFailure} : {})}));
    }
    return;
  }

  if (
    (req.method === "GET" && req.url === "/api/essay-themes") ||
    (req.method === "POST" && req.url === "/api/essay-themes")
  ) {
    let themeDirectory;
    try {
      themeDirectory=directory("static/editor-data");
      const themesPath=`${themeDirectory.path}/essay-themes.json`;
      if (req.method === "GET") {
        const themes = JSON.parse(readLocalFile("static/editor-data/essay-themes.json").content);

        if (!Array.isArray(themes)) {
          throw new Error("The local essay themes file is not a valid array");
        }

        res.writeHead(200, {"Content-Type": "application/json"});
        res.end(JSON.stringify({ok: true, themes}));
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
      const themes = JSON.parse(readLocalFile("static/editor-data/essay-themes.json").content);

      if (!Array.isArray(themes)) {
        throw new Error("The local essay themes file is not a valid array");
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

      const temporaryPath = themesPath + ".tmp";

      const identity=writeExclusive(temporaryPath,JSON.stringify(themes,null,2)+"\n");
      try { fs.renameSync(temporaryPath,themesPath); }
      finally { ownedUnlink(temporaryPath,identity); }

      console.log("Local essay theme added:", cleanTheme);

      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({
        ok: true,
        theme: cleanTheme,
        themes,
        local: true
      }));
    } catch (error) {
      console.error("Local essay theme error:", error.message);

      const statusCode =
        error.statusCode ||
        (error instanceof ValidationError || error instanceof SyntaxError
          ? 400
          : 500);

      res.writeHead(statusCode, {"Content-Type": "application/json"});
      res.end(JSON.stringify({error: error.message}));
    } finally { if(themeDirectory) themeDirectory.close(); }

    return;
  }

  if (req.method === "GET" && req.url === "/api/documents") {
    try {
      const localDocuments = listLocalDocuments();
      const permalinkMap = listHugoPermalinks();

      const documents = localDocuments.map(item => ({
        ...item,
        permalink: permalinkMap.get(item.path) || null
      }));

      console.log(
        "Local documents listed:",
        documents.length
      );

      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({
        ok: true,
        documents
      }));
    } catch (error) {
      console.error("Local document list error:", error.message);

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
      const file = readLocalFile(path);
      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({ok:true,path,sha:file.sha,content:file.content,
        connections:matter(file.content).data.connections||[],metadata:readDocumentMetadata(file.content,path),socialCard:await socialCardJob(path,file.sha,true),local:true}));
    } catch (error) {
      console.error("GitHub error:", error.message);

      res.writeHead(error.statusCode || (error.code === "ENOENT" ? 404 : 500), {"Content-Type": "application/json"});
      res.end(JSON.stringify({error:error.saveFailure?error.message:"The local document could not be opened safely.",...(error.saveFailure?{save:error.saveFailure}:{})}));
    }

    return;
  }

  res.writeHead(404, {"Content-Type": "application/json"});
  res.end(JSON.stringify({error: "Not found"}));
});

server.listen(1314, "127.0.0.1", () => {
  console.log("Lilamaya editor API listening on http://127.0.0.1:1314");
});
