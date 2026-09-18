/*
 * A throwaway copy of the repo that scripts/build-site.mjs can be pointed at
 * (VHF_BUILD_ROOT), so tests can build, break content and build again without
 * touching the real content/ to prove a point.
 *
 * The artwork payload is filtered out: tens of megabytes of photographs make
 * every test slow and prove nothing. The two published artwork directories
 * still have to exist, because the build treats a missing entry in its
 * allowlist as an error.
 */
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function runBuild(buildRoot) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "build-site.mjs")], {
      env: { ...process.env, VHF_BUILD_ROOT: buildRoot },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

export async function makeFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vhf-build-"));
  await fs.cp(path.join(ROOT, "content"), path.join(dir, "content"), {
    recursive: true,
    filter: (src) => !path.relative(ROOT, src).replace(/\\/g, "/").startsWith("content/artwork/")
  });
  await fs.cp(path.join(ROOT, "web"), path.join(dir, "web"), { recursive: true });
  await fs.mkdir(path.join(dir, "content", "artwork", "brand"), { recursive: true });
  await fs.mkdir(path.join(dir, "content", "artwork", "curated"), { recursive: true });
  return dir;
}

export const exists = (p) => fs.access(p).then(() => true, () => false);

/*
 * Removing the fixture is done with retries because on Windows a just-exited
 * build process (or a virus scanner reading the files behind it) can still
 * hold a handle for a moment, and rmdir fails with EBUSY/EPERM. In node:test
 * a throwing `t.after` is reported as a failing test, so without this the
 * suite fails intermittently for a reason that has nothing to do with the
 * code under test — and `npm run publish` refuses to publish on a failed
 * test, which would block a content refresh at the worst possible time.
 */
export const cleanup = (dir) =>
  fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
