import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { piDisplay, primeDisplay } from "../dist/index.js";
import { tuiSpecifier } from "../dist/shared.js";
import { truncateWithoutHost } from "../dist/truncate.js";

const WIDE_LINES = [
  `┌${"─".repeat(150)}┐`,
  "漢字".repeat(40),
  "🙂".repeat(40),
  "a".repeat(120),
  "",
  "short",
];
const colored = { fg: (_color, text) => `\x1b[38;2;10;20;30m${text}\x1b[39m` };
const osc8 = (text, url) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

test("every rendered line fits the width the host passes in", async () => {
  await primeDisplay();
  const { visibleWidth } = await import("@earendil-works/pi-tui");
  const view = {
    requested: "unicode",
    display: { format: "unicode", content: WIDE_LINES.join("\n") },
    image: undefined,
    title: "title ".repeat(20),
    notes: ["n".repeat(90)],
    details: () => ["d".repeat(90)],
  };
  const options = { expanded: true, isPartial: false };
  for (const width of [1, 8, 34, 80]) {
    const context = piDisplay.resolveContext(view, options, undefined);
    const lines = piDisplay.renderResult(view, options, colored, context).render(width);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `${width} columns: ${JSON.stringify(line)}`);
    }
    assert.ok(
      lines.some((line) => line.includes("…")),
      `${width} columns: nothing was cut`,
    );
  }
});

test("without the host, lines are cut by a conservative column count", async () => {
  const { visibleWidth } = await import("@earendil-works/pi-tui");
  assert.equal(truncateWithoutHost("plain ascii", 40), "plain ascii");
  assert.equal(truncateWithoutHost("abcdefgh", 5), "abc…");
  assert.equal(truncateWithoutHost("🙂".repeat(30), 7), "🙂🙂…");
  assert.equal(truncateWithoutHost("漢字".repeat(30), 1), "");
  assert.equal(truncateWithoutHost("anything", 0), "");
  for (const line of WIDE_LINES) {
    for (const width of [1, 7, 34]) {
      assert.ok(visibleWidth(truncateWithoutHost(line, width)) <= width, `${width}: ${line}`);
    }
  }
});

test("without the host, a line that fits keeps its colors and links", () => {
  const short = colored.fg("toolOutput", "short");
  assert.equal(truncateWithoutHost(short, 40), short);
  const link = osc8("title", "file:///x");
  assert.equal(truncateWithoutHost(link, 40), link);
});

test("without the host, a cut line loses its colors and links", async () => {
  const { visibleWidth } = await import("@earendil-works/pi-tui");
  const cut = truncateWithoutHost(colored.fg("toolOutput", "─".repeat(100)), 40);
  assert.equal(cut.includes("\x1b"), false);
  const wrapped = colored.fg("toolOutput", osc8("t".repeat(50), "file:///x"));
  const cutLink = truncateWithoutHost(wrapped, 10);
  assert.ok(visibleWidth(cutLink) <= 10, JSON.stringify(cutLink));
  assert.equal(cutLink, `${"t".repeat(8)}…`);
});

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

/** Runs a script in a child process whose host entry resolves a fake TUI package. */
async function runWithHostTui(packageName, moduleLines, scriptLines) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-diagram-fake-host-")));
  try {
    const tui = join(root, "node_modules", ...packageName.split("/"));
    const entry = join(root, "host.mjs");
    await mkdir(tui, { recursive: true });
    await writeFile(
      join(tui, "package.json"),
      JSON.stringify({ name: packageName, type: "module", main: "index.js" }),
    );
    await writeFile(join(tui, "index.js"), moduleLines.join("\n"));
    await writeFile(
      entry,
      [
        `import { displayLoaded, imagesSupported, primeDisplay, renderDiagramCall } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};`,
        "await primeDisplay();",
        'const call = { subject: "diagram", profile: "test", saveDirectory: undefined };',
        ...scriptLines,
      ].join("\n"),
    );
    await promisify(execFile)(process.execPath, [entry]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const FAKE_TUI_CLASSES = [
  "export class Text { constructor(text = '') { this.text = text; } render() { return [this.text]; } }",
  "export class Container { addChild() {} render() { return []; } }",
  "export class Image { render() { return []; } }",
];

test("an OMP host supplies image capabilities and line truncation", async () => {
  await runWithHostTui(
    "@oh-my-pi/pi-tui",
    [
      'export const TERMINAL = { imageProtocol: "\\x1b_G", hyperlinks: true };',
      "export const truncateToWidth = (text, width, ellipsis) => text.length <= width ? text : text.slice(0, width - 1) + ellipsis;",
      ...FAKE_TUI_CLASSES,
    ],
    [
      'if (!displayLoaded()) throw new Error("OMP TUI did not load");',
      'if (!imagesSupported()) throw new Error("OMP image protocol was not detected");',
      "const plain = { fg: (_color, text) => text };",
      'if (renderDiagramCall(call, plain).render(80)[0] !== "diagram diagram (test)") throw new Error("OMP TUI was not used");',
      'if (renderDiagramCall(call, plain).render(8)[0] !== "diagram…") throw new Error("OMP truncateToWidth was not used");',
    ],
  );
});

test("a host without truncateToWidth gets fitted lines that keep their colors", async () => {
  await runWithHostTui(
    "@earendil-works/pi-tui",
    [
      'export const TERMINAL = { imageProtocol: "\\x1b_G", hyperlinks: true };',
      ...FAKE_TUI_CLASSES,
    ],
    [
      'if (!imagesSupported()) throw new Error("image protocol was not detected");',
      "const colored = { fg: (_color, text) => '\\x1b[31m' + text + '\\x1b[39m' };",
      "const [wide] = renderDiagramCall(call, colored).render(80);",
      'if (!wide.includes("\\x1b[31m")) throw new Error("colors were stripped from a line that fits: " + JSON.stringify(wide));',
      "const [cut] = renderDiagramCall(call, colored).render(8);",
      'if (cut !== "diagra…") throw new Error("conservative cut was not used: " + JSON.stringify(cut));',
    ],
  );
});
