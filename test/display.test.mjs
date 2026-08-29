import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { tuiSpecifier } from "../dist/display.js";

/** A local checkout has its own copy of the library, which wins by bare name. */
test("the terminal library is taken from the host, not from this package", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-diagram-host-")));
  try {
    const installed = join(root, "node_modules", "@earendil-works", "pi-tui");
    await mkdir(join(installed, "dist"), { recursive: true });
    await writeFile(join(root, "cli.js"), "");
    await writeFile(
      join(installed, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-tui", type: "module", main: "dist/index.js" }),
    );
    await writeFile(join(installed, "dist", "index.js"), "export const marker = 1;\n");

    const resolved = tuiSpecifier(join(root, "cli.js"));
    assert.equal(resolved, pathToFileURL(join(installed, "dist", "index.js")).href);
    assert.equal((await import(resolved)).marker, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlinked host entry resolves its own terminal library", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-diagram-symlinked-host-")));
  try {
    const entry = join(root, "bin", "pi");
    const target = join(root, "lib", "cli.js");
    const installed = join(root, "lib", "node_modules", "@earendil-works", "pi-tui");
    await mkdir(join(installed, "dist"), { recursive: true });
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(target, "");
    await writeFile(
      join(installed, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-tui", type: "module", main: "dist/index.js" }),
    );
    await writeFile(join(installed, "dist", "index.js"), "export const marker = 1;\n");
    await symlink(target, entry);

    assert.equal(tuiSpecifier(entry), pathToFileURL(join(installed, "dist", "index.js")).href);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a host with no copy of its own uses the statically imported fallback", () => {
  assert.equal(tuiSpecifier("/nowhere/cli.js"), undefined);
  assert.equal(tuiSpecifier(undefined), undefined);
});

test("an OMP host exposes its terminal image capabilities", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-diagram-omp-host-")));
  try {
    const tui = join(root, "node_modules", "@oh-my-pi", "pi-tui");
    const entry = join(root, "omp.mjs");
    await mkdir(tui, { recursive: true });
    await writeFile(
      join(tui, "package.json"),
      JSON.stringify({ name: "@oh-my-pi/pi-tui", type: "module", main: "index.js" }),
    );
    await writeFile(
      join(tui, "index.js"),
      [
        'export const TERMINAL = { imageProtocol: "\\x1b_G", hyperlinks: true };',
        "export class Text { constructor(text = '') { this.text = text; } render() { return [this.text]; } }",
        "export class Container { addChild() {} render() { return []; } }",
        "export class Image { render() { return []; } }",
      ].join("\n"),
    );
    await writeFile(
      entry,
      [
        `import { displayLoaded, imagesSupported, primeDisplay, renderDiagramCall } from ${JSON.stringify(new URL("../dist/display.js", import.meta.url).href)};`,
        "await primeDisplay();",
        'if (!displayLoaded()) throw new Error("OMP TUI did not load");',
        'if (!imagesSupported()) throw new Error("OMP image protocol was not detected");',
        'if (renderDiagramCall({ subject: "diagram", profile: "test", saveDirectory: undefined }, { fg: (_color, text) => text }).render(80)[0] !== "diagram diagram (test)") throw new Error("OMP TUI was not used");',
      ].join("\n"),
    );
    await promisify(execFile)(process.execPath, [entry]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
