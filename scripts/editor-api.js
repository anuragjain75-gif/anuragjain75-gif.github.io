const http = require("http");

const GITHUB_OWNER = "anuragjain75-gif";
const GITHUB_REPO = "anuragjain75-gif.github.io";
const GITHUB_BRANCH = "main";

function isAllowedPath(path) {
  const allowed = [
    "content/essays/",
    "content/fragments/",
    "content/paintings/"
  ];

  return (
    typeof path === "string" &&
    !path.includes("..") &&
    !path.startsWith("/") &&
    allowed.some(prefix => path.startsWith(prefix)) &&
    path.endsWith(".md")
  );
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
      !item.path.endsWith("/index.md") ||
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
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", async () => {
      try {
        const {path, content, sha} = JSON.parse(body);

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
        console.error("GitHub write error:", error.message);

        res.writeHead(500, {"Content-Type": "application/json"});
        res.end(JSON.stringify({error: error.message}));
      }
    });

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

      let body = "";

      req.on("data", chunk => {
        body += chunk;
      });

      req.on("end", async () => {
        try {
          const {theme} = JSON.parse(body);

          if (typeof theme !== "string" || !theme.trim()) {
            throw new Error("A theme is required");
          }

          const currentFile = await getGitHubFile(themesPath);
          const themes = JSON.parse(currentFile.content);

          const cleanTheme = theme.trim();

          if (!themes.includes(cleanTheme)) {
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
            return;
          }

          res.writeHead(200, {"Content-Type": "application/json"});
          res.end(JSON.stringify({
            ok: true,
            theme: cleanTheme,
            themes,
            unchanged: true
          }));
        } catch (error) {
          console.error("Essay theme write error:", error.message);

          res.writeHead(500, {"Content-Type": "application/json"});
          res.end(JSON.stringify({error: error.message}));
        }
      });

      return;
    } catch (error) {
      console.error("Essay theme read error:", error.message);

      res.writeHead(500, {"Content-Type": "application/json"});
      res.end(JSON.stringify({error: error.message}));
      return;
    }
  }

  if (req.method === "GET" && req.url === "/api/documents") {
    try {
      const documents = await listGitHubDocuments();

      console.log("GitHub documents listed:", documents.length);

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

  if (req.method === "GET" && req.url.startsWith("/api/document")) {
    const url = new URL(req.url, "http://localhost:1314");
    const path = url.searchParams.get("path");

    if (!isAllowedPath(path)) {
      res.writeHead(400, {"Content-Type": "application/json"});
      res.end(JSON.stringify({error: "Path is not allowed"}));
      return;
    }

    try {
      const file = await getGitHubFile(path);

      console.log("GitHub file read:", file.path);
      console.log("SHA:", file.sha);
      console.log("Content length:", file.content.length);

      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({
        ok: true,
        path: file.path,
        sha: file.sha,
        content: file.content
      }));
    } catch (error) {
      console.error("GitHub error:", error.message);

      res.writeHead(500, {"Content-Type": "application/json"});
      res.end(JSON.stringify({error: error.message}));
    }

    return;
  }

  if (req.method === "GET") {
    res.writeHead(404, {"Content-Type": "application/json"});
    res.end(JSON.stringify({error: "Not found"}));
    return;
  }

  try {
    const file = await getGitHubFile(
      "content/essays/the-art-of-becoming-whole/index.md"
    );

    console.log("GitHub file read:", file.path);
    console.log("SHA:", file.sha);
    console.log("Content length:", file.content.length);

    res.writeHead(200, {"Content-Type": "application/json"});
    res.end(JSON.stringify({
      ok: true,
      path: file.path,
      sha: file.sha,
      content: file.content
    }));
  } catch (error) {
    console.error("GitHub error:", error.message);

    res.writeHead(500, {"Content-Type": "application/json"});
    res.end(JSON.stringify({error: error.message}));
  }
});

server.listen(1314, () => {
  console.log("Lilamaya editor API listening on http://localhost:1314");
});
