#!/usr/bin/env node
/*
 * The one command that publishes the display.
 *
 *   validate -> build -> test -> push -> verify the television can see it
 *
 * Publishing is a push to `main`: the GitHub Actions workflow in
 * .github/workflows/deploy-pages.yml runs the same build and republishes
 * GitHub Pages. That means "git push" is only the *start* of a publish, and a
 * green push tells you nothing about whether the site actually changed — hence
 * the last step, which polls the live version manifest until it advances.
 *
 * This script is the single place the publish transport lives. Skills, the
 * scheduled content task and (M5) the admin publish button all call it rather
 * than spelling out the steps, so changing hosts changes one file.
 *
 * Usage:
 *   npm run publish                      -- full sequence
 *   npm run publish -- -m "message"      -- with an explicit commit message
 *   npm run publish -- --dry-run         -- validate/build/test, never push
 *   npm run publish -- --verify-only     -- just poll the live version
 *   npm run publish -- --timeout 600     -- seconds to wait for Pages (default 420)
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISHED_CONTENT } from "./build-site.mjs";
import { lintContentDir } from "./lint-content.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

/*
 * Paths whose changes belong to a publish. Anything else in the working tree
 * (notes, experiments, the artwork candidates awaiting review) is deliberately
 * left uncommitted rather than swept into a content commit.
 */
const PUBLISH_PATHS = [
  "content",
  "web",
  "scripts",
  "sources",
  "tests",
  "docs",
  "package.json",
  "package-lock.json",
  ".github"
];

const BRANCH = "main";
const POLL_INTERVAL_MS = 15_000;

function parseArgs(argv) {
  const opts = { dryRun: false, verifyOnly: false, message: null, timeoutMs: 420_000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--verify-only") opts.verifyOnly = true;
    else if (arg === "-m" || arg === "--message") opts.message = argv[++i];
    else if (arg === "--timeout") opts.timeoutMs = Number(argv[++i]) * 1000;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error("--timeout must be a positive number of seconds");
  }
  return opts;
}

function run(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      shell: process.platform === "win32",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    let out = "";
    let err = "";
    if (capture) {
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
    }
    child.on("error", reject);
    child.on("close", (code) => {
      /* Trailing-only trim: a porcelain status line's leading space is data. */
      if (code === 0) resolve(out.replace(/\s+$/, ""));
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}${err ? "\n" + err.trim() : ""}`));
    });
  });
}

const git = (...args) => run("git", args, { capture: true });

async function readPublishUrl() {
  const settings = JSON.parse(
    await fs.readFile(path.join(ROOT, "content", "settings.json"), "utf8")
  );
  const url = settings.publishUrl;
  if (!url) throw new Error("content/settings.json has no publishUrl");
  return url.replace(/\/+$/, "");
}

/*
 * The live manifest, or null if the site is unreachable or serving something
 * that isn't the manifest. Cache-busted: GitHub Pages sits behind a CDN, and a
 * cached copy of the *old* version.json would make a successful publish look
 * like a timeout.
 */
async function fetchLiveVersion(publishUrl) {
  const url = `${publishUrl}/content/version.json?t=${Date.now()}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.version === "number" ? body : null;
  } catch {
    return null;
  }
}

async function preflight() {
  const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== BRANCH) {
    throw new Error(
      `on branch "${branch}", but publishing deploys "${BRANCH}". ` +
        "Merge to main first — pushing another branch will not update the display."
    );
  }
}

/*
 * What this publish will commit, and what it will leave alone.
 *
 * Tracked edits under PUBLISH_PATHS are the publish. Untracked files are the
 * risk: a content refresh must not sweep up whatever else happens to be in the
 * working tree — half-finished artwork candidates, scratch notes, a script
 * still being written. So an untracked file is staged only if the build would
 * actually publish it; everything else is reported and left for a deliberate
 * commit.
 */
async function classifyChanges() {
  const status = await git("status", "--porcelain", "--", ...PUBLISH_PATHS);
  const staging = [];
  const heldBack = [];
  for (const line of status ? status.split("\n") : []) {
    /* Porcelain v1: two status chars, a space, then the path. A rename reads
     * "R  old -> new"; only the new path can be staged. */
    const entry = /^..\s(.*)$/.exec(line)?.[1];
    if (!entry) continue;
    const filePath = entry.split(" -> ").pop().replace(/^"|"$/g, "").replace(/\/$/, "");
    if (line.startsWith("??") && !buildPublishes(filePath)) heldBack.push(filePath);
    else staging.push(filePath);
  }
  return { staging, heldBack };
}

/* True if `filePath` lands in dist/ — i.e. the display actually reads it. */
function buildPublishes(filePath) {
  const rel = filePath.split("/");
  if (rel[0] === "content") {
    const under = rel.slice(1).join("/");
    return PUBLISHED_CONTENT.some((p) => under === p || under.startsWith(p + "/") || p.startsWith(under + "/"));
  }
  return rel[0] === "web";
}

function defaultMessage(paths) {
  const areas = new Set(paths.map((p) => p.split("/").slice(0, 2).join("/")));
  return `Publish: update ${[...areas].sort().join(", ")}`;
}

async function waitForPublish(publishUrl, previous, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const previousVersion = previous ? previous.version : 0;
  process.stdout.write("[publish] waiting for GitHub Pages to serve the new build");
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    process.stdout.write(".");
    const live = await fetchLiveVersion(publishUrl);
    if (live && live.version > previousVersion) {
      process.stdout.write("\n");
      return live;
    }
  }
  process.stdout.write("\n");
  return null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const publishUrl = await readPublishUrl();
  console.log(`[publish] target: ${publishUrl}`);

  const before = await fetchLiveVersion(publishUrl);
  console.log(
    before
      ? `[publish] live version: ${before.version} (built ${before.builtAt})`
      : "[publish] live version: unreachable — will still verify after pushing"
  );

  if (opts.verifyOnly) {
    if (!before) throw new Error("could not read the live version manifest");
    return;
  }

  await preflight();

  console.log("\n[publish] step 0/5 — content lint (advisory, never blocks a publish)");
  const lintWarnings = await lintContentDir(path.join(ROOT, "content"));
  if (lintWarnings.length === 0) {
    console.log("[publish] lint: no display-appropriateness warnings");
  } else {
    console.log(`[publish] lint: ${lintWarnings.length} warning(s) — review before/after publishing, but continuing`);
    for (const w of lintWarnings) console.log(`  - [${w.file}] ${w.id}: ${w.reason}`);
  }

  console.log("\n[publish] step 1/5 — build (validates content/ first)");
  await run("node", ["scripts/build-site.mjs"]);

  console.log("\n[publish] step 2/5 — tests");
  await run("npm", ["test"]);

  console.log("\n[publish] step 3/5 — commit");
  const { staging, heldBack } = await classifyChanges();
  const unpushed = await git("log", "--oneline", `origin/${BRANCH}..HEAD`);

  for (const p of heldBack) {
    console.log(`  · ${p} — untracked and not published by the build; left uncommitted`);
  }

  if (staging.length === 0 && !unpushed) {
    console.log("[publish] nothing to publish — working tree and origin/main agree.");
    console.log(
      "[publish] to force a rebuild of the live site anyway, run the " +
        '"Deploy to GitHub Pages" workflow manually from the repo\'s Actions tab.'
    );
    return;
  }

  if (staging.length > 0) {
    for (const p of staging) console.log(`  + ${p}`);
    if (opts.dryRun) {
      console.log("[publish] --dry-run: stopping before commit.");
      return;
    }
    await git("add", "--", ...staging);
    await git("commit", "-m", opts.message || defaultMessage(staging));
  } else {
    console.log(`[publish] nothing new to commit; ${unpushed.split("\n").length} commit(s) to push`);
    if (opts.dryRun) {
      console.log("[publish] --dry-run: stopping before push.");
      return;
    }
  }

  console.log("\n[publish] step 4/5 — push");
  await run("git", ["push", "origin", BRANCH]);

  console.log("\n[publish] step 5/5 — verify the display can see it");
  const after = await waitForPublish(publishUrl, before, opts.timeoutMs);
  if (!after) {
    throw new Error(
      "the live version manifest did not advance before the timeout. " +
        "The push succeeded, so check the repo's Actions tab: the deploy may have " +
        "failed, or it may simply still be running. Re-check with " +
        "`npm run publish -- --verify-only`."
    );
  }
  console.log(`[publish] published version ${after.version} (built ${after.builtAt})`);
  console.log("[publish] the television picks this up on its next content poll.");
}

main().catch((err) => {
  console.error("\n[publish] FAILED: " + err.message);
  process.exitCode = 1;
});
