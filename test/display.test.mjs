import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
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
