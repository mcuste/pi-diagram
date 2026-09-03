import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import piDiagram from "../dist/extension.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(packageRoot));
const readManifest = async (directory) =>
  JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
const manifest = await readManifest(packageRoot);
const rootManifest = await readManifest(repositoryRoot);

/** Both hosts read these manifest keys to find the extension. */
const HOST_KEYS = ["pi", "omp"];
const WORKSPACE_PACKAGES = ["core", "d2", "display", "plugin"];

test("both host manifests declare the same existing entry point", async () => {
  for (const key of HOST_KEYS) {
    const entries = manifest[key]?.extensions;
    assert.deepEqual(entries, ["./dist/extension.js"], `${key}.extensions`);
    await access(join(packageRoot, entries[0]));
  }
});

test("the repository root points hosts installing from git at the same entry point", async () => {
  for (const key of HOST_KEYS) {
    const entries = rootManifest[key]?.extensions;
    assert.deepEqual(entries, ["./packages/plugin/dist/extension.js"], `root ${key}.extensions`);
    await access(join(repositoryRoot, entries[0]));
  }
});

test("the published package ships the declared entry point", () => {
  assert.equal(manifest.exports, "./dist/extension.js");
  // The unbundled `dist/index.js` imports the private packages, so only the bundle is published.
  assert.ok(manifest.files.includes("dist/extension.js"));
  assert.ok(!manifest.files.includes("dist"));
  for (const asset of ["dist/guidance.md", "dist/tool-description.md"]) {
    assert.ok(manifest.files.includes(asset), asset);
  }
});

/** Packages the bundle leaves external. Everything else in the workspace must be inlined. */
const EXTERNALS = new Set([
  "@resvg/resvg-js",
  "@xmldom/xmldom",
  "typebox",
  "@earendil-works/pi-tui",
  "@oh-my-pi/pi-tui",
]);

test("the bundle imports only its dependencies and Node built-ins", async () => {
  const bundle = await readFile(join(packageRoot, "dist/extension.js"), "utf8");
  const specifiers = new Set(
    [...bundle.matchAll(/^import\s.*?\sfrom\s"([^"]+)"|import\("([^"]+)"\)/gmu)].map(
      (match) => match[1] ?? match[2],
    ),
  );
  assert.ok(specifiers.size > 0);
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith("node:") || EXTERNALS.has(specifier),
      `${specifier} is neither a dependency nor a Node built-in`,
    );
  }
  for (const name of ["core", "d2", "display"]) {
    assert.ok(!bundle.includes(`@mcuste/pi-diagram-${name}`), `${name} must be inlined`);
  }
});

test("host libraries stay peer dependencies so the host supplies its own copy", () => {
  assert.equal(manifest.peerDependencies.typebox, "*");
  assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], "*");
  // The TUI library is only needed to draw an image, so a host without it still renders text.
  assert.equal(manifest.peerDependenciesMeta["@earendil-works/pi-tui"].optional, true);
});

test("runtime dependencies rasterize images and parse SVG structure", () => {
  assert.deepEqual(Object.keys(manifest.dependencies), ["@resvg/resvg-js", "@xmldom/xmldom"]);
});

test("only the extension is published, and every package carries the release version", async () => {
  for (const name of WORKSPACE_PACKAGES) {
    const workspaceManifest = await readManifest(join(repositoryRoot, "packages", name));
    assert.equal(workspaceManifest.version, rootManifest.version, name);
    assert.equal(workspaceManifest.private, name === "plugin" ? undefined : true, name);
  }
});

test("the entry point registers the diagram tool", async () => {
  const registered = [];
  await piDiagram({
    registerTool(definition) {
      registered.push(definition.name);
    },
  });
  assert.deepEqual(registered, ["diagram"]);
});

test("the Oh My Pi marketplace catalog points back at this package", async () => {
  const catalog = JSON.parse(
    await readFile(join(repositoryRoot, ".omp-plugin/marketplace.json"), "utf8"),
  );
  assert.equal(catalog.plugins.length, 1);
  const [plugin] = catalog.plugins;
  assert.equal(plugin.source.source, "github");
  assert.ok(manifest.repository.url.includes(plugin.source.repo));
  assert.equal(plugin.homepage, `https://github.com/${plugin.source.repo}`);
});
