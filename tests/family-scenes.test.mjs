/*
 * The impact and crisis information families: no photo, and text that clears
 * 4.5:1 on their grounds.
 * Run with: node --test tests/family-scenes.test.mjs
 *
 * Both defects were live on the television: the crisis slide drew a ghosted
 * photo of identifiable people behind "You Are Not Alone", and the impact
 * slides set navy on olive (2.62:1) over a ghosted, veiled photo.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fakeElement(tag) {
  return {
    tagName: tag,
    className: "",
    textContent: "",
    children: [],
    attributes: {},
    style: { setProperty() {} },
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
    getAttribute(k) {
      return this.attributes[k];
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    insertBefore(child) {
      this.children.unshift(child);
      return child;
    },
    addEventListener() {},
    querySelector() {
      return null;
    }
  };
}

async function loadScenes() {
  const source = await fs.readFile(path.join(ROOT, "web", "js", "scenes.js"), "utf8");
  const sandbox = { console: { log() {}, warn() {}, error() {} }, document: { createElement: fakeElement } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.VhfScenes;
}

function walk(node, out = []) {
  out.push(node);
  for (const child of node.children || []) walk(child, out);
  return out;
}

const hasClass = (node, cls) => (" " + node.className + " ").includes(" " + cls + " ");

// Photos everywhere a wash could be drawn from: the gallery, a curated set
// named after the item, and the washSources route.
function photoRichData(itemId) {
  const photo = (id) => ({ id, src: `https://images.example.test/${id}.jpg`, width: 1600, height: 1000 });
  return {
    gallery: { photos: [photo("g1"), photo("g2")] },
    curated: { [itemId]: [photo("c1")], other: [photo("c2")] },
    settings: {},
    events: { events: [] }
  };
}

function photoImages(scene) {
  // The corner brand mark is a local logo, not a photograph.
  return walk(scene).filter((n) => n.tagName === "img" && !/artwork\/brand\//.test(n.src || ""));
}

for (const family of ["crisis", "impact"]) {
  test(`${family} slides build no wash, no fade, and request no photo`, async () => {
    const scenes = await loadScenes();
    for (const washSources of [undefined, ["other"]]) {
      const item = {
        id: "slide-" + family,
        type: "information",
        content: { family, title: "Title", body: "Body", washSources }
      };
      const scene = scenes.render(item, photoRichData(item.id));
      const nodes = walk(scene);
      assert.ok(hasClass(scene, "scene--" + family));
      assert.equal(nodes.filter((n) => hasClass(n, "scene__wash")).length, 0, "no wash element");
      assert.equal(nodes.filter((n) => hasClass(n, "scene__fade")).length, 0, "no fade element");
      assert.deepEqual(photoImages(scene).map((n) => n.src), [], "no photograph is fetched");
      assert.ok(!/scene--(split|wide)/.test(scene.className), "no shape layout chosen from a photo");
    }
  });
}

test("a story slide still gets its photo wash (the fix is scoped to the two families)", async () => {
  const scenes = await loadScenes();
  const item = { id: "program-x", type: "information", content: { title: "Title" } };
  const scene = scenes.render(item, photoRichData(item.id));
  assert.equal(walk(scene).filter((n) => hasClass(n, "scene__wash")).length, 1);
  assert.equal(walk(scene).filter((n) => hasClass(n, "scene__fade")).length, 1);
});

test("the crisis callout renders on its own line; elsewhere it is ignored", async () => {
  const scenes = await loadScenes();
  const crisis = scenes.render(
    { id: "c", type: "information", content: { family: "crisis", title: "You Are Not Alone", callout: "Dial 988, then press 1" } },
    {}
  );
  const callouts = walk(crisis).filter((n) => hasClass(n, "scene__callout"));
  assert.equal(callouts.length, 1);
  assert.equal(callouts[0].textContent, "Dial 988, then press 1");

  const story = scenes.render({ id: "s", type: "information", content: { title: "T", callout: "x" } }, {});
  assert.equal(walk(story).filter((n) => hasClass(n, "scene__callout")).length, 0);
});

test("the published crisis slide carries the Veterans Crisis Line instruction as its callout", async () => {
  const playlist = JSON.parse(await fs.readFile(path.join(ROOT, "content", "playlist.json"), "utf8"));
  const crisis = playlist.playlist.find((i) => i.id === "crisis-line");
  assert.equal(crisis.content.family, "crisis");
  assert.match(crisis.content.callout, /\b988\b.*\bpress 1\b/);
});

/*
 * ---- Contrast, computed from the theme tokens ----
 * WCAG 2 relative luminance. Body text is 32px, below the 3:1 large-text
 * size, so every pair here must clear 4.5:1.
 */
function luminance(hex) {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

async function themeTokens() {
  const css = await fs.readFile(path.join(ROOT, "web", "css", "theme.css"), "utf8");
  const raw = {};
  for (const m of css.matchAll(/(--vhf-[\w-]+)\s*:\s*([^;]+);/g)) raw[m[1]] = m[2].trim();
  const resolve = (name, depth = 0) => {
    const v = raw[name];
    assert.ok(v !== undefined, `token ${name} is defined`);
    const ref = /^var\((--vhf-[\w-]+)\)$/.exec(v);
    return ref && depth < 10 ? resolve(ref[1], depth + 1) : v;
  };
  return resolve;
}

test("impact and crisis text tokens clear 4.5:1 on their grounds", async () => {
  const token = await themeTokens();
  const pairs = [
    ["impact", "--vhf-text-on-impact", "--vhf-bg-impact"],
    ["crisis", "--vhf-text-on-crisis", "--vhf-bg-crisis"]
  ];
  for (const [name, fg, bg] of pairs) {
    const ratio = contrast(token(fg), token(bg));
    assert.ok(ratio >= 4.5, `${name}: ${token(fg)} on ${token(bg)} is ${ratio.toFixed(2)}:1`);
  }
});

test("impact and crisis eyebrows use their family text colour, not the terracotta accent", async () => {
  const css = (await fs.readFile(path.join(ROOT, "web", "css", "scene.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
  // Every rule that colours an impact/crisis eyebrow must use the family token.
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, sel]) => /\.scene--(impact|crisis)[^,{]*\.scene__eyebrow(?![\w-:])/.test(sel))
    .filter(([, , body]) => /(^|;|\s)color\s*:/.test(body));
  assert.ok(rules.length >= 2, "both families colour their eyebrow");
  for (const [, sel, body] of rules) {
    const color = /(?:^|;|\s)color\s*:\s*([^;]+)/.exec(body)[1].trim();
    assert.match(color, /^var\(--vhf-text-on-(impact|crisis)\)$/, `${sel.trim()} -> ${color}`);
  }
});
