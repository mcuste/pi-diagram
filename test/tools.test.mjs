import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { TextRenderUnavailableError } from "../dist/d2/runner.js";
import { registerDiagramTools } from "../dist/tools.js";

const UNICODE_DIAGRAM = "┌────┐\n│ a  │\n└────┘";

function register(renderer) {
  const tools = new Map();
  registerDiagramTools(
    {
      registerTool(definition) {
        tools.set(definition.name, definition);
      },
    },
    renderer ? { renderer } : {},
  );
  return tools.get("diagram");
}

const SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>';

function createRenderer(answer = UNICODE_DIAGRAM) {
  const calls = [];
  return {
    calls,
    renderText(argument) {
      calls.push(argument);
      if (answer instanceof Error) {
        return Promise.reject(answer);
      }
      return Promise.resolve({ text: answer, version: "v0.8.1-HEAD" });
    },
    renderSvg() {
      return Promise.resolve({ svg: SVG, version: "v0.8.1-HEAD" });
    },
  };
}

function run(diagram, parameters) {
  return diagram.execute("call-1", parameters, undefined, () => {}, { cwd: process.cwd() });
}

const diagram = register();
const parameters = diagram.parameters;

function accepts(args) {
  return Value.Check(parameters, args);
}

test("only a repository write asks for approval", () => {
  assert.equal(diagram.approval({ source: "a -> b" }), "read");
  assert.equal(diagram.approval({ source: "a -> b", formats: ["svg"] }), "read");
  assert.equal(diagram.approval({ source: "a -> b", save: { dir: "docs" } }), "write");
  assert.equal(diagram.approval(undefined), "read");
});

test("approval details name the exact files a call would write", () => {
  assert.equal(diagram.formatApprovalDetails({ source: "a -> b" }), undefined);
  assert.deepEqual(
    diagram.formatApprovalDetails({
      source: "a -> b",
      title: "Request Lifecycle!",
      save: { dir: "docs/arch" },
    }),
    ["Writes docs/arch/request-lifecycle.d2", "Writes docs/arch/request-lifecycle.svg"],
  );
});

test("approval details fall back to intent when the request will be refused anyway", () => {
  // No title and no basename, so the call itself reports why. The prompt only needs the intent.
  assert.deepEqual(diagram.formatApprovalDetails({ source: "a -> b", save: { dir: "docs" } }), [
    "Writes diagram artifacts into docs",
  ]);
});

test("a diagram kept out of the repository prompts for nothing", () => {
  assert.equal(diagram.formatApprovalDetails({ source: "a -> b", formats: ["svg"] }), undefined);
});

test("the description shows the model the D2 syntax it needs", () => {
  for (const example of ["client -> gateway", "sequence_diagram", "sql_table", "shape: image"]) {
    assert.ok(diagram.description.includes(example), example);
  }
});

test("source is the only required field", () => {
  assert.ok(accepts({ source: "a -> b" }));
  assert.ok(!accepts({}));
  assert.ok(!accepts({ source: "" }));
});

test("every documented field is accepted", () => {
  assert.ok(
    accepts({
      source: "a -> b",
      language: "d2",
      title: "Request lifecycle",
      profile: "architecture",
      render: "unicode",
      formats: ["source", "svg"],
      save: { dir: "docs/diagrams", basename: "request-lifecycle" },
    }),
  );
});

test("undocumented fields and values are rejected", () => {
  assert.ok(!accepts({ source: "a -> b", layout: "dagre" }));
  assert.ok(!accepts({ source: "a -> b", theme: 4 }));
  assert.ok(!accepts({ source: "a -> b", language: "graphviz" }));
  assert.ok(!accepts({ source: "a -> b", profile: "pretty" }));
  assert.ok(!accepts({ source: "a -> b", render: "svg" }));
  assert.ok(!accepts({ source: "a -> b", formats: ["pdf"] }));
  assert.ok(!accepts({ source: "a -> b", save: { sketch: true } }));
  // A repository destination has to be named; there is no default location.
  assert.ok(!accepts({ source: "a -> b", save: {} }));
});

test("a file request asks for at least one distinct format", () => {
  assert.ok(!accepts({ source: "a -> b", formats: [] }));
  assert.ok(!accepts({ source: "a -> b", formats: ["svg", "svg"] }));
});

test("a successful call puts the diagram and its title in the transcript", async () => {
  const renderer = createRenderer();
  const result = await run(register(renderer), { source: "a -> b", title: "Request path" });
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.equal(result.content[0].text, `Request path\n\n${UNICODE_DIAGRAM}`);
  assert.equal(renderer.calls[0].source, "a -> b");
});

test("the diagram alone is returned when there is no title", async () => {
  const result = await run(register(createRenderer()), { source: "a -> b" });
  assert.equal(result.content[0].text, UNICODE_DIAGRAM);
});

test("details describe the render without repeating the diagram", async () => {
  const result = await run(register(createRenderer()), {
    source: "a -> b",
    title: "Request path",
    profile: "architecture",
    render: "auto",
  });
  const { sourceHash, ...rest } = result.details;
  assert.match(sourceHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(rest, {
    language: "d2",
    title: "Request path",
    profile: "architecture",
    requested: "auto",
    renderedAs: "unicode",
    lineCount: 3,
    widthCells: 6,
    d2Version: "v0.8.1-HEAD",
  });
  assert.ok(!JSON.stringify(result.details).includes("\u250c"), "details repeat the diagram");
});

test("a fallback to plain ASCII is reported to the user and recorded in details", async () => {
  let first = true;
  const renderer = {
    renderText() {
      if (first) {
        first = false;
        return Promise.reject(new TextRenderUnavailableError("beta renderer"));
      }
      return Promise.resolve({ text: "+--+\n|a |\n+--+", version: "v0.8.1-HEAD" });
    },
  };

  const result = await run(register(renderer), { source: "a -> b" });
  assert.match(result.content[0].text, /note: Unicode output failed/);
  assert.equal(result.details.renderedAs, "ascii");
  assert.deepEqual(result.details.notes, [
    "Unicode output failed, so this diagram is drawn in plain ASCII.",
  ]);
});

test("Mermaid source is refused with what to send instead", async () => {
  const renderer = createRenderer();
  await assert.rejects(
    run(register(renderer), { source: "graph TD; A-->B", language: "mermaid" }),
    { name: "DiagramSourceError", message: /Mermaid input is not enabled.*Send D2 source/s },
  );
  assert.deepEqual(renderer.calls, []);
});

test("unsafe source is refused before D2 is started", async () => {
  const renderer = createRenderer();
  await assert.rejects(run(register(renderer), { source: "s: { icon: /etc/hosts }" }), {
    name: "DiagramSourceError",
    message: /D2_ICON/,
  });
  assert.deepEqual(renderer.calls, []);
});

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);

function createRasterizer() {
  return {
    rasterize() {
      return Promise.resolve({ png: PNG_BYTES, widthPx: 800, heightPx: 600, systemFonts: false });
    },
  };
}

function registerWithImages() {
  const tools = new Map();
  registerDiagramTools(
    {
      registerTool(definition) {
        tools.set(definition.name, definition);
      },
    },
    { renderer: createRenderer(), rasterizer: createRasterizer() },
  );
  return tools.get("diagram");
}

const theme = { fg: (_color, text) => text };

test("an image is produced only in a terminal, since nothing else can show one", async () => {
  const tool = registerWithImages();
  for (const [mode, expected] of [
    ["tui", "image"],
    ["print", "unicode"],
    ["rpc", "unicode"],
    [undefined, "unicode"],
  ]) {
    const result = await tool.execute("call-1", { source: "a -> b" }, undefined, () => {}, {
      cwd: process.cwd(),
      mode,
    });
    assert.equal(result.details.renderedAs, expected, String(mode));
    assert.equal(result.details.image === undefined, expected !== "image", String(mode));
  }
});

test("the image never travels in the content the model reads", async () => {
  const tool = registerWithImages();
  const result = await tool.execute("call-1", { source: "a -> b" }, undefined, () => {}, {
    cwd: process.cwd(),
    mode: "tui",
  });
  assert.deepEqual(
    result.content.map((block) => block.type),
    ["text"],
  );
  assert.equal(result.content[0].text.includes(PNG_BYTES.toString("base64")), false);
  assert.match(result.content[0].text, /┌/);
});

test("the host renders its own text when there is no image to show", () => {
  const tool = registerWithImages();
  const context = { showImages: true, state: {} };
  assert.throws(
    () => tool.renderResult({ content: [], details: {} }, { expanded: false }, theme, context),
    /no image/,
  );
});

test("an image is shown as a component, and only when images are turned on", async () => {
  const { primeDisplay } = await import("../dist/display.js");
  await primeDisplay();
  const tool = registerWithImages();
  const result = await tool.execute("call-1", { source: "a -> b" }, undefined, () => {}, {
    cwd: process.cwd(),
    mode: "tui",
  });

  const component = tool.renderResult(result, { expanded: false }, theme, {
    showImages: true,
    state: {},
  });
  assert.equal(typeof component.render, "function");
  assert.ok(component.render(120).length > 0);

  assert.throws(
    () => tool.renderResult(result, { expanded: false }, theme, { showImages: false, state: {} }),
    /images are turned off/,
  );
});

test("the image is read once per result row", async () => {
  const { primeDisplay } = await import("../dist/display.js");
  await primeDisplay();
  const tool = registerWithImages();
  const result = await tool.execute("call-1", { source: "a -> b" }, undefined, () => {}, {
    cwd: process.cwd(),
    mode: "tui",
  });

  const state = {};
  const context = { showImages: true, state };
  tool.renderResult(result, { expanded: false }, theme, context);
  assert.equal(state.diagramImage.path, result.details.image.path);
  // A second render reuses what was read, rather than reading the file again.
  const { rm } = await import("node:fs/promises");
  await rm(result.details.image.path, { force: true });
  assert.ok(tool.renderResult(result, { expanded: true }, theme, context));
});

/** pi-tui exposes this so both code paths can be exercised; it is the same copy display.ts uses. */
async function withCapabilities(images, body) {
  const tui = await import("@earendil-works/pi-tui");
  const previous = tui.getCapabilities();
  tui.setCapabilities({ ...previous, images });
  try {
    return await body();
  } finally {
    tui.setCapabilities(previous);
  }
}

test("a terminal with no image protocol gets the text, not a filename", async () => {
  const { primeDisplay } = await import("../dist/display.js");
  await primeDisplay();
  const tool = registerWithImages();
  const result = await tool.execute("call-1", { source: "a -> b" }, undefined, () => {}, {
    cwd: process.cwd(),
    mode: "tui",
  });

  await withCapabilities(null, () => {
    assert.throws(
      () => tool.renderResult(result, { expanded: false }, theme, { showImages: true, state: {} }),
      /no image protocol/,
    );
  });
  // The same result still draws where the terminal can show one.
  await withCapabilities("kitty", () => {
    assert.ok(
      tool.renderResult(result, { expanded: false }, theme, { showImages: true, state: {} }),
    );
  });
});

test("no image is drawn at all for a terminal that cannot show one", async () => {
  const { primeDisplay } = await import("../dist/display.js");
  await primeDisplay();
  const tool = registerWithImages();
  const result = await withCapabilities(null, () =>
    tool.execute("call-1", { source: "a -> b" }, undefined, () => {}, {
      cwd: process.cwd(),
      mode: "tui",
    }),
  );
  assert.equal(result.details.image, undefined);
  assert.equal(result.details.renderedAs, "unicode");
});
