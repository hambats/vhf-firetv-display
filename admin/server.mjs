#!/usr/bin/env node
/*
 * Local-only admin server (Phase 7, brought forward early at the user's
 * explicit request — CLAUDE.md's own phase order says not to build this
 * before the appliance is reliable, so keep it exactly what it is: a small,
 * local, dev-only tool, not a hosted admin product).
 *
 * Binds to 127.0.0.1 only. Serves admin/index.html + admin/app.js and a
 * small JSON API for reading/writing content/*.json, plus endpoints to run
 * the existing build/sync/deploy scripts so edits actually take effect.
 *
 * Every write goes through the same validateContentDir() used by
 * build-site.mjs — a save that would leave content/ invalid is rejected and
 * the previous file is restored, so this can never produce a broken deploy.
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateContentDir, CONTENT_FILES } from "../scripts/validate-content.mjs";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONTENT_DIR = path.join(ROOT, "content");
const PORT = 8787;

const STATIC_TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function send(res, status, body, contentType) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": contentType || (typeof body === "string" ? "text/plain" : "application/json"),
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.join(__dirname, rel);
  if (!filePath.startsWith(__dirname)) return send(res, 403, "forbidden");
  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    send(res, 200, body.toString("utf8"), STATIC_TYPES[ext] || "application/octet-stream");
  } catch {
    send(res, 404, "not found");
  }
}

async function handleGetContent(req, res, name) {
  const relPath = CONTENT_FILES[name];
  if (!relPath) return send(res, 400, { error: `unknown content file "${name}"` });
  try {
    const raw = await fs.readFile(path.join(CONTENT_DIR, relPath), "utf8");
    send(res, 200, raw, "application/json");
  } catch (err) {
    send(res, 404, { error: err.message });
  }
}

async function handleSaveContent(req, res, name) {
  const relPath = CONTENT_FILES[name];
  if (!relPath) return send(res, 400, { error: `unknown content file "${name}"` });

  const raw = await readBody(req);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return send(res, 400, { error: `not valid JSON: ${err.message}` });
  }

  const filePath = path.join(CONTENT_DIR, relPath);
  let previous = null;
  try {
    previous = await fs.readFile(filePath, "utf8");
  } catch {
    // File may not exist yet (first save) — nothing to restore in that case.
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(parsed, null, 2) + "\n");

  const errors = await validateContentDir(CONTENT_DIR);
  const relevant = errors.filter((e) => e.startsWith(`content/${relPath}`) || e.startsWith(relPath));

  if (relevant.length > 0) {
    if (previous !== null) {
      await fs.writeFile(filePath, previous);
    } else {
      await fs.rm(filePath, { force: true });
    }
    return send(res, 400, { error: "validation failed, change was not saved", details: relevant });
  }

  send(res, 200, { ok: true });
}

async function handleRun(req, res, script, args) {
  try {
    const { stdout, stderr } = await execFileAsync("node", [script, ...(args || [])], {
      cwd: ROOT,
      timeout: 10 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024
    });
    send(res, 200, { ok: true, output: stdout + (stderr ? "\n" + stderr : "") });
  } catch (err) {
    send(res, 200, { ok: false, output: (err.stdout || "") + "\n" + (err.stderr || err.message) });
  }
}

async function handleDeploy(req, res) {
  try {
    const isWin = process.platform === "win32";
    const { stdout, stderr } = await execFileAsync(isWin ? "netlify.cmd" : "netlify", ["deploy", "--prod"], {
      cwd: ROOT,
      timeout: 10 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
      shell: isWin
    });
    send(res, 200, { ok: true, output: stdout + (stderr ? "\n" + stderr : "") });
  } catch (err) {
    send(res, 200, { ok: false, output: (err.stdout || "") + "\n" + (err.stderr || err.message) });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === "/api/content" && req.method === "GET") {
      return await handleGetContent(req, res, url.searchParams.get("file"));
    }
    if (url.pathname === "/api/content" && req.method === "POST") {
      return await handleSaveContent(req, res, url.searchParams.get("file"));
    }
    if (url.pathname === "/api/build" && req.method === "POST") {
      return await handleRun(req, res, "scripts/build-site.mjs");
    }
    if (url.pathname === "/api/sync-gallery" && req.method === "POST") {
      return await handleRun(req, res, "sources/gallery/index.mjs");
    }
    if (url.pathname === "/api/deploy" && req.method === "POST") {
      return await handleDeploy(req, res);
    }
    if (req.method === "GET") {
      return await serveStatic(req, res, url.pathname);
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[admin] http://127.0.0.1:${PORT} (local only)`);
});
