/**
 * Scenarios against the real D2 CLI. Split from the deterministic suites by filename so that
 * skipping them is visible in the run rather than hidden behind an environment variable.
 *
 * Assertions describe structure, not exact drawings: the beta text renderer changes output
 * between releases, so golden art would break on every upgrade without telling us anything.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { D2Cli } from "../dist/d2/runner.js";
import registerInto from "../dist/index.js";
import { renderDiagram } from "../dist/render.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const BOX_DRAWING = /[─-╿]/u;

async function tool() {
  const tools = new Map();
  const flags = new Map();
  await registerInto({
    registerTool: (definition) => tools.set(definition.name, definition),
    registerFlag: (name, options) => flags.set(name, options.default),
    getFlag: (name) => flags.get(name),
  });
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
    assert.equal(rendering.display.kind, "unicode", name);
    assert.match(rendering.display.content, BOX_DRAWING, name);
    assert.ok(rendering.lineCount > 2, `${name} produced ${rendering.lineCount} lines`);
    assert.ok(rendering.widthCells > 2, `${name} produced ${rendering.widthCells} columns`);
    assert.match(rendering.d2Version, /^v?\d+\.\d+\.\d+/u, name);
  }
});

test("labels survive into the drawing", async () => {
  const flow = await draw("flow.d2");
  for (const label of ["client", "gateway", "api", "database", "request"]) {
    assert.ok(flow.display.content.includes(label), `flow lost ${label}`);
  }

  const sequence = await draw("sequence.d2");
  for (const label of ["user", "web", "api", "db"]) {
    assert.ok(sequence.display.content.includes(label), `sequence lost ${label}`);
  }

  const erd = await draw("erd.d2");
  for (const label of ["users", "orders", "user_id", "varchar"]) {
    assert.ok(erd.display.content.includes(label), `erd lost ${label}`);
  }
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
  const diagram = await tool();
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

test("the real CLI formats the source before it is checked in", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-e2e-"));
  try {
    await renderDiagram(
      {
        source: "a->b:  hello\nc:   {  d  }",
        title: "Sloppy",
        formats: ["source"],
        save: { dir: "docs/diagrams" },
        cwd: root,
      },
      new D2Cli(),
    );

    const saved = await readFile(join(root, "docs/diagrams/sloppy.d2"), "utf8");
    assert.equal(saved, "a -> b: hello\nc: {d}\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a diagram saves as editable source and a viewable SVG", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-e2e-"));
  try {
    const rendering = await renderDiagram(
      {
        source: await fixture("containers.d2"),
        title: "Service layout",
        save: { dir: "docs/diagrams" },
        cwd: root,
      },
      new D2Cli(),
    );

    assert.deepEqual(
      rendering.saved.map((artifact) => artifact.path),
      ["docs/diagrams/service-layout.d2", "docs/diagrams/service-layout.svg"],
    );

    const saved = await readFile(join(root, "docs/diagrams/service-layout.d2"), "utf8");
    assert.equal(saved, await fixture("containers.d2"));

    const svg = await readFile(join(root, "docs/diagrams/service-layout.svg"), "utf8");
    assert.ok(svg.startsWith("<?xml") || svg.startsWith("<svg"), svg.slice(0, 40));
    assert.ok(svg.trimEnd().endsWith("</svg>"));
    for (const label of ["gateway", "postgres", "worker"]) {
      assert.ok(svg.includes(label), `SVG lost ${label}`);
    }
    // The transcript still shows the diagram; saving is in addition to it, not instead.
    assert.equal(rendering.display.kind, "unicode");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Reads the SVG a profile produces, without keeping any of it in the repository. */
async function drawSvg(name, profile) {
  const rendering = await renderDiagram(
    { source: await fixture(name), profile, formats: ["svg"] },
    new D2Cli(),
  );
  const artifact = rendering.saved.find((saved) => saved.format === "svg");
  const svg = await readFile(artifact.path, "utf8");
  await rm(artifact.path, { force: true });
  return { rendering, svg, size: canvasOf(svg) };
}

function canvasOf(svg) {
  const found = /width="(\d+)" height="(\d+)"/u.exec(svg);
  assert.ok(found, "the SVG reports no canvas size");
  return { widthPx: Number(found[1]), heightPx: Number(found[2]) };
}

test("each profile draws the same source differently", async () => {
  const drawn = new Map();
  for (const profile of ["explain", "architecture", "data", "docs", "tree", "c4", "dependency"]) {
    const result = await drawSvg("containers.d2", profile);
    assert.equal(result.rendering.profile, profile);
    drawn.set(profile, result);
  }
  const size = (profile) => drawn.get(profile).size;

  // More room between the ranks, so the same containers occupy a taller canvas.
  assert.ok(
    size("architecture").heightPx > size("explain").heightPx,
    `architecture ${size("architecture").heightPx} vs explain ${size("explain").heightPx}`,
  );
  // Tighter than a conversational diagram, because tables and classes are tall already.
  assert.ok(
    size("data").heightPx < size("explain").heightPx,
    `data ${size("data").heightPx} vs explain ${size("explain").heightPx}`,
  );
  // Padded for a page, so the canvas is wider than the drawing needs in a transcript.
  assert.ok(
    size("docs").widthPx > size("explain").widthPx,
    `docs ${size("docs").widthPx} vs explain ${size("explain").widthPx}`,
  );
  assert.ok(
    size("dependency").heightPx < size("data").heightPx,
    `dependency ${size("dependency").heightPx} vs data ${size("data").heightPx}`,
  );
  // The other engine lays the same source out differently, not just at another size.
  assert.notEqual(
    `${size("tree").widthPx}x${size("tree").heightPx}`,
    `${size("explain").widthPx}x${size("explain").heightPx}`,
  );

  // c4 is architecture under another palette, so it is the one pair that shares a geometry.
  assert.deepEqual(size("c4"), size("architecture"));
  assert.notEqual(drawn.get("c4").svg, drawn.get("architecture").svg);
});

test("only a conversational diagram is drawn by hand", async () => {
  // D2 draws sketch mode with pattern fills, which nothing else in the safe subset produces.
  const sketched = (svg) => svg.includes("<pattern");
  assert.ok(sketched((await drawSvg("flow.d2", undefined)).svg), "the default is not sketched");
  assert.ok(sketched((await drawSvg("flow.d2", "explain")).svg), "explain is not sketched");
  for (const profile of ["architecture", "data", "docs", "tree", "c4", "dependency"]) {
    assert.ok(!sketched((await drawSvg("flow.d2", profile)).svg), `${profile} is sketched`);
  }
});

test("a hierarchy keeps every edge it was given", async () => {
  const { svg } = await drawSvg("tree.d2", "tree");
  const source = await fixture("tree.d2");
  const edges = source.trim().split("\n").length;
  // One stroked path per edge. A tree layout that cannot route them draws none at all.
  assert.equal((svg.match(/class="connection stroke-/gu) ?? []).length, edges);
  for (const label of ["platform", "scheduler", "observability", "limits"]) {
    assert.ok(svg.includes(label), `the tree lost ${label}`);
  }
});

test("a saved diagram follows the reader into dark mode", async () => {
  for (const profile of ["explain", "docs"]) {
    const { svg } = await drawSvg("flow.d2", profile);
    assert.match(svg, /@media[^{]*prefers-color-scheme:\s*dark/u, profile);
  }
});

test("the profile changes the picture, not the drawing in the transcript", async () => {
  const source = await fixture("containers.d2");
  const drawn = [];
  for (const profile of ["explain", "architecture", "data", "docs"]) {
    drawn.push((await renderDiagram({ source, profile }, new D2Cli())).display.content);
  }
  // D2 draws text in character cells, so theme and spacing have nothing to change there.
  assert.equal(new Set(drawn).size, 1);
  assert.match(drawn[0], BOX_DRAWING);
});

test("real SVG output carries no active or remote content", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-e2e-"));
  try {
    for (const name of ["flow.d2", "sequence.d2", "erd.d2", "klass.d2"]) {
      const rendering = await renderDiagram(
        {
          source: await fixture(name),
          title: name.replace(".d2", ""),
          save: { dir: "docs/diagrams" },
          cwd: root,
        },
        new D2Cli(),
      );
      const svgPath = rendering.saved.find((artifact) => artifact.format === "svg").path;
      const svg = (await readFile(join(root, svgPath), "utf8")).toLowerCase();
      for (const forbidden of ["<script", "<foreignobject", "<iframe"]) {
        assert.ok(!svg.includes(forbidden), `${name} SVG contains ${forbidden}`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a txt sidecar holds the same drawing shown in the transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-e2e-"));
  try {
    const rendering = await renderDiagram(
      {
        source: await fixture("flow.d2"),
        title: "Request flow",
        formats: ["txt"],
        save: { dir: "docs/design" },
        cwd: root,
      },
      new D2Cli(),
    );
    const written = await readFile(join(root, "docs/design/request-flow.txt"), "utf8");
    assert.equal(written, `${rendering.display.content}\n`);
    assert.match(written, BOX_DRAWING);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the tool the hosts load saves through the real CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-e2e-"));
  try {
    const result = await (await tool()).execute(
      "e2e-save",
      { source: await fixture("flow.d2"), title: "Request path", save: { dir: "docs/diagrams" } },
      undefined,
      () => {},
      { cwd: root },
    );
    assert.match(
      result.content[0].text,
      /saved in the repository: docs\/diagrams\/request-path\.d2, docs\/diagrams\/request-path\.svg/,
    );
    assert.deepEqual(result.details.outputs, {
      location: "workspace",
      sourcePath: "docs/diagrams/request-path.d2",
      svgPath: "docs/diagrams/request-path.svg",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a real diagram is drawn as a real PNG, with its own fonts", async () => {
  const rendering = await renderDiagram({ source: await fixture("erd.d2") }, new D2Cli());

  const image = rendering.image;
  assert.ok(image, "no image was produced");
  assert.equal(image.widthPx > 0 && image.heightPx > 0, true);

  const bytes = await readFile(image.path);
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "the file is not a PNG",
  );
  // The header has to agree with what was reported, since the terminal scales by these numbers.
  assert.equal(bytes.readUInt32BE(16), image.widthPx);
  assert.equal(bytes.readUInt32BE(20), image.heightPx);
  // A diagram with labels compresses to far more than an empty canvas would.
  assert.ok(bytes.length > 4096, `the image is only ${bytes.length} bytes`);
  // The text drawing is still there, because the terminal may not show images.
  assert.match(rendering.display.content, BOX_DRAWING);
  assert.deepEqual(rendering.notes, []);
});

test("labels the diagram's own font cannot draw are reported, not silently dropped", async () => {
  const rendering = await renderDiagram(
    { source: 'a: "注文"\na -> b', render: "image" },
    new D2Cli(),
  );
  assert.ok(rendering.image, "no image was produced");
  assert.match(rendering.notes.join("\n"), /fonts installed on this machine/);
});

test("a saved png holds the same image the terminal was given", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-e2e-"));
  try {
    const rendering = await renderDiagram(
      {
        source: await fixture("flow.d2"),
        title: "Flow",
        formats: ["source", "svg", "png"],
        save: { dir: "docs/diagrams" },
        cwd: root,
      },
      new D2Cli(),
    );

    assert.deepEqual(
      rendering.saved.map((artifact) => artifact.path),
      ["docs/diagrams/flow.d2", "docs/diagrams/flow.svg", "docs/diagrams/flow.png"],
    );
    assert.deepEqual(
      await readFile(join(root, "docs/diagrams/flow.png")),
      await readFile(rendering.image.path),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
