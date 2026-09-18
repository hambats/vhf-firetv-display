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

function isPathInsideDir(dir, filePath) {
  const rel = path.relative(dir, filePath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  // Strip any query/hash the URL constructor already removed, and reject
  // attempts to escape admin/ via ../ or URL-encoded traversal sequences —
  // path.join + path.relative below is what actually enforces this; decoding
  // happens via URL parsing before we ever get urlPath.
  const filePath = path.join(__dirname, rel);
  if (!isPathInsideDir(__dirname, filePath)) return send(res, 403, "forbidden");
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

/*
 * Display status panel (M5 "display status", cheapest option — see
 * docs/BUILD_TREE.md §1a): this is NOT a heartbeat. It fetches the LIVE
 * published site's content/version.json server-side (avoids any GitHub
 * Pages CORS question) so staff can see what the TV *should* currently be
 * running, plus the local dist/ build's version.json for comparison if one
 * exists. Never throws past the caller — an unreachable live site is a
 * normal, expected state for this endpoint to report, not a server error.
 */
async function fetchLiveVersion() {
  let settings;
  try {
    settings = JSON.parse(await fs.readFile(path.join(CONTENT_DIR, "settings.json"), "utf8"));
  } catch (err) {
    return { ok: false, error: `couldn't read content/settings.json: ${err.message}` };
  }
  const publishUrl = settings.publishUrl;
  if (!publishUrl) return { ok: false, error: "no publishUrl configured in content/settings.json" };

  const url = `${publishUrl.replace(/\/+$/, "")}/content/version.json?t=${Date.now()}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let res;
    try {
      res = await fetch(url, { cache: "no-store", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { ok: false, error: `published site returned HTTP ${res.status}`, url };
    const manifest = await res.json();
    return { ok: true, url, version: manifest.version, builtAt: manifest.builtAt };
  } catch (err) {
    return { ok: false, error: `couldn't reach the published site: ${err.message}`, url };
  }
}

async function fetchLocalVersion() {
  try {
    const raw = await fs.readFile(path.join(ROOT, "dist", "content", "version.json"), "utf8");
    const manifest = JSON.parse(raw);
    return { ok: true, version: manifest.version, builtAt: manifest.builtAt };
  } catch {
    return { ok: false, error: "no local dist/ build found — run Build first" };
  }
}

async function handleStatus(req, res) {
  const [live, local] = await Promise.all([fetchLiveVersion(), fetchLocalVersion()]);
  send(res, 200, { live, local });
}

/*
 * Publishing lives in scripts/publish.mjs and nowhere else — this handler runs
 * it rather than spelling out a deploy command, so a change of host never
 * leaves the admin button quietly deploying to the wrong place. The script
 * validates, builds, tests, pushes and then verifies the live version actually
 * advanced, so its exit code is meaningful.
 */
async function handleDeploy(req, res) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [path.join(ROOT, "scripts", "publish.mjs")],
      {
        cwd: ROOT,
        timeout: 15 * 60 * 1000,
        maxBuffer: 32 * 1024 * 1024
      }
    );
    send(res, 200, { ok: true, output: stdout + (stderr ? "\n" + stderr : "") });
  } catch (err) {
    send(res, 200, { ok: false, output: (err.stdout || "") + "\n" + (err.stderr || err.message) });
  }
}

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

/*
 * Binding to 127.0.0.1 keeps the network out, but not a malicious page open
 * in a browser on this same machine — it can still fire a cross-origin POST
 * at this server (the browser only blocks the page from reading the
 * response). DNS rebinding can reach it too. Reject anything whose Host
 * header isn't exactly this server's own address, and, when an Origin header
 * is present (any browser-initiated cross-origin or same-origin fetch sends
 * one), require it to match as well. Same-origin requests from
 * admin/index.html served at http://127.0.0.1:PORT/ always send a Host of
 * 127.0.0.1:PORT and, when present, an Origin of http://127.0.0.1:PORT, so
 * legitimate traffic is unaffected.
 */
function isTrustedOrigin(req) {
  const host = req.headers.host;
  if (!ALLOWED_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (!ALLOWED_HOSTS.has(originUrl.host)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (!isTrustedOrigin(req)) {
    return send(res, 403, { error: "forbidden: bad Host/Origin" });
  }

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
    if (url.pathname === "/api/status" && req.method === "GET") {
      return await handleStatus(req, res);
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
