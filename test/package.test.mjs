import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import piDiagram from "../dist/index.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));

/** Both hosts read these manifest keys to find the extension. */
const HOST_KEYS = ["pi", "omp"];

test("both host manifests declare the same existing entry point", async () => {
  for (const key of HOST_KEYS) {
    const entries = manifest[key]?.extensions;
    assert.deepEqual(entries, ["./src/index.ts"], `${key}.extensions`);
    await access(join(packageRoot, entries[0]));
  }
});

test("the published package ships the declared entry point", () => {
  // The manifest points at TypeScript source, so `src` must be published too.
  assert.ok(manifest.files.includes("src"));
  assert.ok(manifest.files.includes("dist"));
});

test("host libraries stay peer dependencies so the host supplies its own copy", () => {
  assert.equal(manifest.peerDependencies.typebox, "*");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], "*");
  // The TUI library is only needed to draw an image, so a host without it still renders text.
  assert.equal(manifest.peerDependenciesMeta["@earendil-works/pi-tui"].optional, true);
});

test("the only runtime dependency is the SVG rasterizer", () => {
  assert.deepEqual(Object.keys(manifest.dependencies), ["@resvg/resvg-js"]);
});

test("the entry point registers the diagram tool and render preference", async () => {
  const registered = [];
  const flags = new Map();
  await piDiagram({
    registerTool(definition) {
      registered.push(definition.name);
    },
    registerFlag(name, options) {
      flags.set(name, options.default);
    },
    getFlag(name) {
      return flags.get(name);
    },
  });
  assert.deepEqual(registered, ["diagram"]);
  assert.equal(flags.has("diagram-render"), true);
});

test("the Oh My Pi marketplace catalog points back at this package", async () => {
  const catalog = JSON.parse(
    await readFile(join(packageRoot, ".omp-plugin/marketplace.json"), "utf8"),
  );
  assert.equal(catalog.plugins.length, 1);
  const [plugin] = catalog.plugins;
  assert.equal(plugin.source.source, "github");
  assert.ok(manifest.repository.url.includes(plugin.source.repo));
  assert.equal(plugin.homepage, `https://github.com/${plugin.source.repo}`);
});
