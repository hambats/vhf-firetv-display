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

/*
 * How to spawn a command so its argv arrives intact.
 *
 * Only npm needs a shell, and only on Windows, because npm is a .cmd shim
 * there. Everything else -- git above all -- is a real executable and is
 * spawned directly. Sending git through cmd.exe too (as this used to) put the
 * commit message at cmd's mercy: cmd does not understand \" as an escape, so
 * `-m 'Rename "Q&A" slide'` was cut at the & and the remainder run as a
 * command, and any %NAME% in a message was expanded. The npm call never
 * carries user text, so quoting its few fixed args for cmd is enough.
 */
export function quoteForCmd(arg) {
  return /[\s"^&|<>()%]/.test(arg) ? `"${String(arg).replace(/"/g, '\\"')}"` : arg;
}

export function spawnPlan(command, args, platform = process.platform) {
  const shell = platform === "win32" && command === "npm";
  return { command, args: shell ? args.map(quoteForCmd) : args, shell };
}

function run(command, args, { capture = false, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const plan = spawnPlan(command, args);
    const child = spawn(plan.command, plan.args, {
      cwd: ROOT,
      shell: plan.shell,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    let out = "";
    let err = "";
    if (capture) {
      // setEncoding, not `out += buffer`: a multi-byte character split across
      // two chunks would otherwise decode as garbage -- and a file name with
      // one in it then fails to match when it is handed back to git.
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
    }
    child.on("error", reject);
    child.on("close", (code) => {
      /* Trailing-only trim: a porcelain status line's leading space is data. */
      if (code === 0) resolve(raw ? out : out.replace(/\s+$/, ""));
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}${err ? "\n" + err.trim() : ""}`));
    });
  });
}

/*
 * --literal-pathspecs: a staged path is a file name, never a glob. Without it
 * a curated photo named "flyer[1].jpg" is a pattern that matches "flyer1.jpg".
 */
const git = (...args) => run("git", ["--literal-pathspecs", ...args], { capture: true });
const gitRaw = (...args) => run("git", ["--literal-pathspecs", ...args], { capture: true, raw: true });

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

async function preflight({ dryRun }) {
  const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== BRANCH) {
    throw new Error(
      `on branch "${branch}", but publishing deploys "${BRANCH}". ` +
        "Merge to main first — pushing another branch will not update the display."
    );
  }

  /*
   * The CI content sync commits to main most days, so a PC checkout is often
   * behind. Publishing from one used to build, test and commit, then fail at
   * the push (non-fast-forward) with a local commit left behind. Find out
   * first, before anything is committed.
   */
  try {
    await git("fetch", "--quiet", "origin", BRANCH);
  } catch (err) {
    if (dryRun) {
      console.log(`[publish] could not fetch origin/${BRANCH} (dry run continues): ${err.message.split("\n")[0]}`);
      return;
    }
    throw new Error(`could not fetch origin/${BRANCH} to check this checkout is current: ${err.message}`);
  }
  const { behind } = parseAheadBehind(await git("rev-list", "--left-right", "--count", `HEAD...origin/${BRANCH}`));
  if (behind > 0) {
    const message =
      `local ${BRANCH} is ${behind} commit(s) behind origin/${BRANCH} (the CI content sync commits there). ` +
      `Run \`git pull --rebase origin ${BRANCH}\`, then publish again. Nothing has been committed.`;
    if (dryRun) console.log(`[publish] warning: ${message}`);
    else throw new Error(message);
  }
}

/* `git rev-list --left-right --count HEAD...origin/main` prints "<ahead>\t<behind>". */
export function parseAheadBehind(output) {
  const [ahead, behind] = String(output).trim().split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0 };
}

/*
 * `git status --porcelain -z`: entries end in NUL, paths are never quoted or
 * escaped, and a rename is "R  <new>\0<old>\0". The newline format quoted any
 * path with a space or a non-ASCII character and octal-escaped the latter
 * ("Maddie\342\200\231s.jpg"), which no longer names a file when handed back
 * to `git add` -- so one curly apostrophe in a photo's name failed every
 * publish.
 */
export function parsePorcelainZ(output) {
  const tokens = String(output).split("\0");
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 4) continue;
    const entry = { xy: token.slice(0, 2), path: token.slice(3).replace(/\/$/, "") };
    if (/[RC]/.test(entry.xy)) entry.from = tokens[++i];
    entries.push(entry);
  }
  return entries;
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
export function classifyEntries(entries) {
  const staging = [];
  const heldBack = [];
  // A staged rename's old path is a deletion that belongs in the same commit.
  // It goes to `git commit -- <paths>` but not to `git add`, which refuses a
  // path that is in neither the index nor the working tree.
  const renamedFrom = [];
  for (const e of entries) {
    if (e.xy === "??" && !buildPublishes(e.path)) {
      heldBack.push(e.path);
      continue;
    }
    staging.push(e.path);
    if (e.from && e.xy.includes("R")) renamedFrom.push(e.from);
  }
  return { staging, heldBack, renamedFrom };
}

async function classifyChanges() {
  return classifyEntries(parsePorcelainZ(await gitRaw("status", "--porcelain", "-z", "--", ...PUBLISH_PATHS)));
}

/*
 * Commits exactly `paths`. A bare `git commit -m` commits the whole index, so
 * anything already staged elsewhere (an app/ change, a half-done script) rode
 * along into a "Publish:" commit and was pushed to main with it.
 */
export function commitArgs(message, paths) {
  return ["commit", "-m", message, "--", ...paths];
}

/* True if `filePath` lands in dist/ — i.e. the display actually reads it. */
export function buildPublishes(filePath) {
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

/*
 * Is `live` the build this push produced?
 *
 * Not "equal to the version in our dist/": deploy-pages.yml rebuilds the site
 * in CI and stamps its own Date.now(), so the local stamp never reaches the
 * site and an equality check could only ever time out. What is knowable: the
 * deploy's build ran after this push started (its version is that build's
 * timestamp), and it is newer than whatever was live just before the push.
 * The old check was only the second half, against a baseline of 0 when the
 * pre-push read failed -- so the first poll of the *old* manifest "verified".
 *
 * CLOCK_SKEW_MS allows for this machine's clock running a little ahead of
 * GitHub's; the CI build runs well over that long after the push anyway.
 *
 * If the manifest ever carries the commit it was built from, that is exact
 * and wins.
 */
const CLOCK_SKEW_MS = 30_000;

export function isNewBuild(live, { before, pushStartedAt, commit }) {
  if (!live || typeof live.version !== "number") return false;
  if (live.commit && commit) return commit.startsWith(live.commit) || live.commit.startsWith(commit);
  if (before && live.version <= before.version) return false;
  return live.version >= pushStartedAt - CLOCK_SKEW_MS;
}

async function waitForPublish(publishUrl, expect, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  process.stdout.write("[publish] waiting for GitHub Pages to serve the new build");
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    process.stdout.write(".");
    const live = await fetchLiveVersion(publishUrl);
    if (isNewBuild(live, expect)) {
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

  await preflight({ dryRun: opts.dryRun });

  console.log("\n[publish] step 0/5 — content lint (advisory, never blocks a publish)");
  const lintWarnings = await lintContentDir(path.join(ROOT, "content"));
  if (lintWarnings.length === 0) {
    console.log("[publish] lint: no display-appropriateness warnings");
  } else {
    console.log(`[publish] lint: ${lintWarnings.length} warning(s) — review before/after publishing, but continuing`);
    for (const w of lintWarnings) console.log(`  - [${w.file}] ${w.id}: ${w.reason}`);
  }

  console.log("\n[publish] step 1/5 — build (validates content/ first)");
  await run(process.execPath, ["scripts/build-site.mjs"]);

  console.log("\n[publish] step 2/5 — tests");
  await run("npm", ["test"]);

  console.log("\n[publish] step 3/5 — commit");
  const { staging, heldBack, renamedFrom } = await classifyChanges();
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
    await git(...commitArgs(opts.message || defaultMessage(staging), staging.concat(renamedFrom)));
  } else {
    console.log(`[publish] nothing new to commit; ${unpushed.split("\n").length} commit(s) to push`);
    if (opts.dryRun) {
      console.log("[publish] --dry-run: stopping before push.");
      return;
    }
  }

  console.log("\n[publish] step 4/5 — push");
  // Re-read the live version right before pushing: `before` is minutes old by
  // now (build and tests ran since), and may have failed outright.
  const baseline = (await fetchLiveVersion(publishUrl)) || before;
  const commit = await git("rev-parse", "HEAD");
  const pushStartedAt = Date.now();
  await run("git", ["push", "origin", BRANCH]);

  console.log("\n[publish] step 5/5 — verify the display can see it");
  const after = await waitForPublish(publishUrl, { before: baseline, pushStartedAt, commit }, opts.timeoutMs);
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

/* Publishes only when run directly, so tests can import the helpers above. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("\n[publish] FAILED: " + err.message);
    process.exitCode = 1;
  });
}
