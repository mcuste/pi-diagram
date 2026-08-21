/**
 * Scenarios against the real D2 CLI. Split from the deterministic suites by filename so that
 * skipping them is visible in the run rather than hidden behind an environment variable.
 *
 * Assertions describe structure, not exact drawings: the beta text renderer changes output
 * between releases, so golden art would break on every upgrade without telling us anything.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { D2Cli } from "../dist/d2/runner.js";
import registerInto from "../dist/index.js";
import { renderDiagram } from "../dist/render.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const BOX_DRAWING = /[─-╿]/u;

function tool() {
  const tools = new Map();
  registerInto({ registerTool: (definition) => tools.set(definition.name, definition) });
  return tools.get("diagram");
}

async function fixture(name) {
  return readFile(join(fixtures, name), "utf8");
}

async function draw(name, render) {
  const source = await fixture(name);
  return renderDiagram({ source, ...(render ? { render } : {}) }, new D2Cli());
}

test("every diagram fixture renders to Unicode box drawing", async () => {
  const names = (await readdir(fixtures)).filter((name) => name.endsWith(".d2"));
  assert.ok(names.length >= 8, `expected a fixture matrix, found ${names.length}`);

  for (const name of names) {
    const rendering = await draw(name);
    assert.equal(rendering.renderedAs, "unicode", name);
    assert.match(rendering.text, BOX_DRAWING, name);
    assert.ok(rendering.lineCount > 2, `${name} produced ${rendering.lineCount} lines`);
    assert.ok(rendering.widthCells > 2, `${name} produced ${rendering.widthCells} columns`);
    assert.match(rendering.d2Version, /^v?\d+\.\d+\.\d+/u, name);
  }
});

test("labels survive into the drawing", async () => {
  const flow = await draw("flow.d2");
  for (const label of ["client", "gateway", "api", "database", "request"]) {
    assert.ok(flow.text.includes(label), `flow lost ${label}`);
  }

  const sequence = await draw("sequence.d2");
  for (const label of ["user", "web", "api", "db"]) {
    assert.ok(sequence.text.includes(label), `sequence lost ${label}`);
  }

  const erd = await draw("erd.d2");
  for (const label of ["users", "orders", "user_id", "varchar"]) {
    assert.ok(erd.text.includes(label), `erd lost ${label}`);
  }
});

test("plain ASCII output uses no character above 7 bits", async () => {
  const rendering = await draw("containers.d2", "ascii");
  assert.equal(rendering.renderedAs, "ascii");
  for (const character of rendering.text) {
    assert.ok(character.codePointAt(0) < 128, `found ${JSON.stringify(character)}`);
  }
  assert.match(rendering.text, /[+\-|]/u);
});

test("source mode returns D2, not a drawing", async () => {
  const rendering = await draw("flow.d2", "source");
  assert.equal(rendering.renderedAs, "source");
  assert.ok(rendering.text.startsWith("client -> gateway"));
  assert.doesNotMatch(rendering.text, BOX_DRAWING);
});

test("a relative import cannot read a neighbouring file", async () => {
  // The fixture imports sentinel.d2, which sits beside it and holds a marker string. D2 reads
  // such an import and renders its contents, so the preflight has to stop this before D2 runs.
  const sentinel = await fixture("security/sentinel.d2");
  assert.match(sentinel, /PI_DIAGRAM_MUST_NOT_READ_THIS/);

  await assert.rejects(draw("security/relative-import.d2"), (error) => {
    assert.equal(error.name, "DiagramSourceError");
    assert.ok(!error.message.includes("PI_DIAGRAM_MUST_NOT_READ_THIS"), error.message);
    assert.deepEqual(
      error.diagnostics.map((diagnostic) => diagnostic.code),
      ["D2_IMPORT"],
    );
    return true;
  });
});

test("every unsafe fixture is refused with the reason and a place to look", async () => {
  const expected = {
    "absolute-import.d2": "D2_IMPORT",
    "icon-url.d2": "D2_ICON",
    "local-image.d2": "D2_IMAGE_SHAPE",
    "link.d2": "D2_LINK",
    "markdown-label.d2": "D2_BLOCK_STRING",
    "layout-override.d2": "D2_CONFIG",
  };

  for (const [name, code] of Object.entries(expected)) {
    await assert.rejects(draw(`security/${name}`), (error) => {
      assert.equal(error.name, "DiagramSourceError", name);
      const [first] = error.diagnostics;
      assert.equal(first.code, code, name);
      assert.ok(first.line >= 1, `${name} reported no line`);
      assert.ok(first.hint, `${name} reported no hint`);
      return true;
    });
  }
});

test("a syntax error names the line and column and leaks no path", async () => {
  await assert.rejects(renderDiagram({ source: "a -> b\nc -> {\n  d" }, new D2Cli()), (error) => {
    assert.equal(error.name, "DiagramSourceError");
    assert.ok(error.diagnostics.length > 0);
    for (const diagnostic of error.diagnostics) {
      assert.equal(diagnostic.code, "D2_SYNTAX");
      assert.ok(diagnostic.line >= 1);
    }
    assert.doesNotMatch(error.message, /\/(var|tmp|private|Users)\//u, error.message);
    assert.doesNotMatch(error.message, /input\.d2/u, error.message);
    return true;
  });
});

test("a missing D2 binary is reported with install guidance", async () => {
  const missing = new D2Cli({ binary: join(fixtures, "no-such-d2") });
  await assert.rejects(renderDiagram({ source: "a -> b" }, missing), {
    name: "D2UnavailableError",
    message: /brew install d2|go install github\.com\/d2lang\/d2/,
  });
});

test("a cancelled call stops instead of returning a diagram", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    renderDiagram(
      { source: await fixture("containers.d2"), signal: controller.signal },
      new D2Cli(),
    ),
    { name: "CommandCancelledError" },
  );
});

test("the tool the hosts load renders through the real CLI", async () => {
  const diagram = tool();
  const result = await diagram.execute(
    "e2e-1",
    { source: await fixture("flow.d2"), title: "Request path" },
    undefined,
    () => {},
    { cwd: process.cwd() },
  );
  assert.match(result.content[0].text, /^Request path\n\n/u);
  assert.match(result.content[0].text, BOX_DRAWING);
  assert.equal(result.details.renderedAs, "unicode");
});
