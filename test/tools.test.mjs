import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Value } from "typebox/value";
import { TextRenderUnavailableError } from "../dist/d2/runner.js";
import {
  parseRenderPreference,
  registerDiagramPreference,
  registerDiagramTools,
} from "../dist/tools.js";

const UNICODE_DIAGRAM = "┌────┐\n│ a  │\n└────┘";

function register(renderer, renderPreference) {
  const tools = new Map();
  registerDiagramTools(
    {
      registerTool(definition) {
        tools.set(definition.name, definition);
      },
    },
    {
      ...(renderer === undefined ? {} : { renderer }),
      ...(renderPreference === undefined ? {} : { renderPreference }),
    },
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
    formatSource({ source }) {
      return Promise.resolve(`${source}\n`);
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

test("the render preference defaults to Unicode and accepts image opt-in", () => {
  assert.equal(parseRenderPreference(undefined), "unicode");
  assert.equal(parseRenderPreference("unicode"), "unicode");
  assert.equal(parseRenderPreference("image"), "image");
  assert.throws(() => parseRenderPreference("ascii"), /unicode.*image/);
});

test("the extension flag supplies the preference at execution time", async () => {
  const flags = new Map();
  const preference = await registerDiagramPreference(
    {
      registerFlag(name, options) {
        flags.set(name, options.default);
      },
      getFlag(name) {
        return flags.get(name);
      },
    },
    { envPreference: "unicode" },
  );
  assert.equal(await preference(), "unicode");
  flags.set("diagram-render", "image");
  assert.equal(await preference(), "image");
});

test("project configuration added during a session applies to the next call", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-live-config-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const flags = new Map();
  try {
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const preference = await registerDiagramPreference(
      {
        registerFlag(name, options) {
          flags.set(name, options.default);
        },
        getFlag(name) {
          return flags.get(name);
        },
      },
      { agentDir, host: "pi", envPreference: undefined },
    );
    assert.equal(await preference(cwd), "unicode");

    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "pi-diagram.json"), '{"render":"image"}\n');
    assert.equal(await preference(cwd), "image");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
  assert.ok(!accepts({ source: "a -> b", render: "ascii" }));
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

test("details describe the render and carry the diagram for the renderer", async () => {
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
    effectiveRender: "unicode",
    imageSupported: false,
    renderedAs: "unicode",
    textPreview: UNICODE_DIAGRAM,
    source: "a -> b",
    lineCount: 3,
    widthCells: 6,
    d2Version: "v0.8.1-HEAD",
  });
});

test("Unicode failure is never replaced with ASCII", async () => {
  const renderer = createRenderer(new TextRenderUnavailableError("beta renderer"));
  await assert.rejects(run(register(renderer), { source: "a -> b" }), {
    name: "TextRenderUnavailableError",
  });
  assert.equal(renderer.calls.length, 1);
  assert.equal(renderer.calls[0].asciiMode, "extended");
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

function registerWithRasterizer(renderPreference) {
  const tools = new Map();
  registerDiagramTools(
    {
      registerTool(definition) {
        tools.set(definition.name, definition);
      },
    },
    {
      renderer: createRenderer(),
      rasterizer: createRasterizer(),
      ...(renderPreference === undefined ? {} : { renderPreference }),
    },
  );
  return tools.get("diagram");
}

function registerWithImages() {
  return registerWithRasterizer(() => "image");
}

const theme = { fg: (_color, text) => text };

/**
 * Every image test sets the terminal capabilities instead of inheriting them, because whether an
 * image is drawn at all depends on the terminal running the suite, and a CI runner has none. This
 * is the same pi-tui copy display.ts uses.
 */
async function withCapabilities(overrides, body) {
  const tui = await import("@earendil-works/pi-tui");
  const previous = tui.getCapabilities();
  tui.setCapabilities({ ...previous, ...overrides });
  try {
    return await body();
  } finally {
    tui.setCapabilities(previous);
  }
}

/** An image is only produced for a terminal, so these rows need a TUI call. */
function drawInTui(diagram, parameters) {
  return diagram.execute("call-1", parameters, undefined, () => {}, {
    cwd: process.cwd(),
    mode: "tui",
  });
}

test("the waiting row names the diagram, not its source", async () => {
  const { primeDisplay } = await import("../dist/display.js");
  await primeDisplay();
  const tool = register(createRenderer());

  const titled = tool.renderCall({ source: "a -> b", title: "Request path" }, theme).render(120);
  assert.match(titled.join("\n"), /diagram "Request path" \(explain\)/);

  const untitled = tool.renderCall({ source: "a -> b\n\nc -> d", profile: "docs" }, theme);
  assert.match(untitled.render(120).join("\n"), /diagram 2 lines \(docs\)/);

  const saving = tool.renderCall(
    { source: "a -> b", title: "Flow", save: { dir: "docs/diagrams" } },
    theme,
  );
  assert.match(saving.render(120).join("\n"), /\(explain, saving into docs\/diagrams\)/);

  const empty = tool.renderCall({}, theme).render(120).join("\n");
  assert.match(empty, /diagram 0 lines \(explain\)/);
  assert.equal(empty.includes("a -> b"), false);
});

test("an image is produced only in a terminal, since nothing else can show one", async () => {
  const { primeDisplay } = await import("../dist/display.js");
  await primeDisplay();
  const tool = registerWithImages();
  await withCapabilities({ images: "kitty" }, async () => {
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
});

test("the default preference stays Unicode even where images are supported", async () => {
  const { primeDisplay } = await import("../dist/display.js");
  await primeDisplay();
  const tool = registerWithRasterizer();
  await withCapabilities({ images: "kitty" }, async () => {
    const result = await drawInTui(tool, { source: "a -> b" });
    assert.equal(result.details.effectiveRender, "unicode");
    assert.equal(result.details.image, undefined);
    assert.equal(result.details.notes, undefined);
  });
});

test("a project image preference produces an inline image without a request override", async () => {
  const { primeDisplay } = await import("../dist/display.js");
  await primeDisplay();
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-image-config-"));
  const cwd = join(root, "project");
  const flags = new Map();
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "pi-diagram.json"), '{"render":"image"}\n');
    const preference = await registerDiagramPreference(
      {
        registerFlag(name, options) {
          flags.set(name, options.default);
        },
        getFlag(name) {
          return flags.get(name);
        },
      },
      { agentDir: join(root, "agent"), host: "pi", envPreference: undefined },
    );
    const tool = registerWithRasterizer(preference);

    await withCapabilities({ images: "kitty" }, async () => {
      const result = await tool.execute("call-1", { source: "a -> b" }, undefined, () => {}, {
        cwd,
        mode: "tui",
      });
      assert.equal(result.details.effectiveRender, "image");
      assert.equal(result.details.renderedAs, "image");
      assert.ok(result.details.image);

      const rows = tool
        .renderResult(result, { expanded: false }, theme, { showImages: true, state: {} })
        .render(120);
      assert.ok(
        rows.some((row) => row.includes("\x1b_G")),
        rows.join("\n"),
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit image request overrides the Unicode preference", async () => {
  const { primeDisplay } = await import("../dist/display.js");
  await primeDisplay();
  const tool = registerWithRasterizer();
  await withCapabilities({ images: "kitty" }, async () => {
    const result = await drawInTui(tool, { source: "a -> b", render: "image" });
    assert.equal(result.details.effectiveRender, "image");
    assert.ok(result.details.image);
  });
});

test("startup detects host image rendering before the first TUI tool call", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-delayed-tui-"));
  try {
    const tui = join(root, "node_modules", "@earendil-works", "pi-tui");
    const capability = join(root, "capability");
    await mkdir(tui, { recursive: true });
    await writeFile(
      join(tui, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-tui", type: "module", main: "index.js" }),
    );
    await writeFile(
      join(tui, "index.js"),
      [
        'import { writeFileSync } from "node:fs";',
        "await new Promise((resolve) => setTimeout(resolve, 25));",
        'export const getCapabilities = () => { writeFileSync(process.env.CAPABILITY_FILE, "kitty"); return { images: "kitty", hyperlinks: false }; };',
      ].join("\n"),
    );

    const script = [
      `import piDiagram from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};`,
      "const tools = new Map();",
      'const flags = new Map([["diagram-render", "unicode"]]);',
      "await piDiagram({ registerTool(tool) { tools.set(tool.name, tool); }, registerFlag(name, options) { flags.set(name, options.default); }, getFlag(name) { return flags.get(name); } });",
      'if (!tools.has("diagram")) throw new Error("startup did not register the tool");',
    ].join("\n");
    const entry = join(root, "startup.mjs");
    await writeFile(entry, script);
    await promisify(execFile)(process.execPath, [entry], { env: { CAPABILITY_FILE: capability } });
    assert.equal(await readFile(capability, "utf8"), "kitty");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("neither the image nor the diagram travels in the content the model reads", async () => {
  const { primeDisplay } = await import("../dist/display.js");
  await primeDisplay();
  const tool = registerWithImages();
  const result = await withCapabilities({ images: "kitty" }, () =>
    drawInTui(tool, { source: "a -> b" }),
  );
  assert.deepEqual(
    result.content.map((block) => block.type),
    ["text"],
  );
  const text = result.content[0].text;
  assert.equal(text.includes(PNG_BYTES.toString("base64")), false);
  assert.doesNotMatch(text, /┌/);
  assert.match(text, /^Drew the diagram as an image\./);
  assert.match(text, /not repeated here/);
});

test("the diagram is in the content when the host has to print it", async () => {
  const tool = registerWithImages();
  for (const mode of ["print", "rpc", undefined]) {
    const result = await tool.execute("call-1", { source: "a -> b" }, undefined, () => {}, {
      cwd: process.cwd(),
      mode,
    });
    assert.match(result.content[0].text, /┌/, String(mode));
  }
});

test("a diagram with no image is drawn here as text", async () => {
  const { primeDisplay } = await import("../dist/display.js");
  await primeDisplay();
  const tool = register(createRenderer());
  const result = await run(tool, { source: "a -> b", title: "Request path" });
  const component = tool.renderResult(result, { expanded: false }, theme, {
    showImages: true,
    state: {},
  });
  const drawn = component.render(120).join("\n");
  assert.match(drawn, /Request path/);
  assert.match(drawn, /┌/);
});

test("the expanded row adds the render mode, the paths, and the source", async () => {
  const { primeDisplay } = await import("../dist/display.js");
  await primeDisplay();
  const tool = register(createRenderer());
  const result = await run(tool, { source: "a -> b" });
  const context = { showImages: true, state: {} };

  const collapsed = tool
    .renderResult(result, { expanded: false }, theme, context)
    .render(120)
    .join("\n");
  assert.doesNotMatch(collapsed, /a -> b/);

  const expanded = tool
    .renderResult(result, { expanded: true }, theme, context)
    .render(120)
    .join("\n");
  assert.match(
    expanded,
    /Requested auto, resolved to unicode; drawn as box drawing, profile explain, D2 v0\.8\.1-HEAD/,
  );
  assert.match(expanded, /a -> b/);
});

test("an image is shown as a component, and the text takes over when images are off", async () => {
  const { primeDisplay } = await import("../dist/display.js");
  await primeDisplay();
  const tool = registerWithImages();
  const result = await withCapabilities({ images: "kitty" }, () =>
    drawInTui(tool, { source: "a -> b" }),
  );

  const component = tool.renderResult(result, { expanded: false }, theme, {
    showImages: true,
    state: {},
  });
  assert.equal(typeof component.render, "function");
  assert.ok(component.render(120).length > 0);

  const off = tool
    .renderResult(result, { expanded: false }, theme, { showImages: false, state: {} })
    .render(120)
    .join("\n");
  assert.match(off, /┌/);
  assert.match(off, /Image support is unavailable; generated as Unicode\./);
});

test("expanding an image row zooms it to the terminal width", async () => {
  const { primeDisplay } = await import("../dist/display.js");
  await primeDisplay();
  const tool = registerWithImages();

  await withCapabilities({ images: "kitty" }, async () => {
    const result = await drawInTui(tool, { source: "a -> b" });
    const context = { showImages: true, state: {} };
    const draw = (expanded) =>
      tool.renderResult(result, { expanded }, theme, context).render(120).join("\n");
    const size = (drawn) => {
      const command = drawn.split("\n").find((line) => line.includes("\x1b_G"));
      assert.ok(command, drawn);
      return {
        columns: Number(/(?:^|,)c=(\d+)/.exec(command)?.[1]),
        rows: Number(/(?:^|,)r=(\d+)/.exec(command)?.[1]),
      };
    };

    const collapsed = draw(false);
    const expanded = draw(true);
    const preview = size(collapsed);
    const zoomed = size(expanded);
    assert.ok(zoomed.columns > preview.columns, `${preview.columns} -> ${zoomed.columns}`);
    assert.ok(zoomed.rows > preview.rows, `${preview.rows} -> ${zoomed.rows}`);
    assert.match(collapsed, /Ctrl\+O: zoom image/);
    assert.match(expanded, /Ctrl\+O: fit image/);
  });
});

test("an OMP renderer argument does not disable a supported image", async () => {
  const { primeDisplay } = await import("../dist/display.js");
  await primeDisplay();
  const tool = registerWithImages();
  const result = await withCapabilities({ images: "kitty" }, () =>
    drawInTui(tool, { source: "a -> b" }),
  );

  await withCapabilities({ images: "kitty" }, () => {
    const rows = tool
      .renderResult(result, { expanded: false }, theme, { source: "a -> b" })
      .render(120);
    assert.ok(
      rows.some((row) => row.includes("\x1b_G")),
      rows.join("\n"),
    );
  });
});

test("the image is read once per result row", async () => {
  const { primeDisplay } = await import("../dist/display.js");
  await primeDisplay();
  const tool = registerWithImages();
  await withCapabilities({ images: "kitty" }, async () => {
    const result = await drawInTui(tool, { source: "a -> b" });
    const state = {};
    const context = { showImages: true, state };
    tool.renderResult(result, { expanded: false }, theme, context);
    assert.equal(state.diagramImage.path, result.details.image.path);
    // A second render reuses what was read, rather than reading the file again.
    const { rm } = await import("node:fs/promises");
    await rm(result.details.image.path, { force: true });
    assert.ok(tool.renderResult(result, { expanded: true }, theme, context));
  });
});

test("a terminal with no image protocol gets the text, not a filename", async () => {
  const { primeDisplay } = await import("../dist/display.js");
  await primeDisplay();
  const tool = registerWithImages();
  const result = await withCapabilities({ images: "kitty" }, () =>
    drawInTui(tool, { source: "a -> b" }),
  );

  await withCapabilities({ images: null }, () => {
    const drawn = tool
      .renderResult(result, { expanded: false }, theme, { showImages: true, state: {} })
      .render(120)
      .join("\n");
    assert.match(drawn, /┌/);
    assert.doesNotMatch(drawn, /\.png/);
    assert.match(drawn, /Image support is unavailable; generated as Unicode\./);
  });
  // The same result still draws where the terminal can show one.
  await withCapabilities({ images: "kitty" }, () => {
    assert.ok(
      tool.renderResult(result, { expanded: false }, theme, { showImages: true, state: {} }),
    );
  });
});

test("every unavailable image generation warns and uses Unicode", async () => {
  const { primeDisplay } = await import("../dist/display.js");
  await primeDisplay();
  const tool = registerWithImages();
  await withCapabilities({ images: null }, async () => {
    for (const source of ["a -> b", "a -> c"]) {
      const result = await drawInTui(tool, { source });
      assert.equal(result.details.image, undefined);
      assert.equal(result.details.renderedAs, "unicode");
      assert.deepEqual(result.details.notes, [
        "Image support is unavailable; generated as Unicode.",
      ]);
      assert.match(result.content[0].text, /Image support is unavailable; generated as Unicode\./);
    }
  });
});

test("the drawn diagram links to its file, so a click opens it for zooming", async () => {
  const { primeDisplay } = await import("../dist/display.js");
  const { pathToFileURL } = await import("node:url");
  const { basename } = await import("node:path");
  await primeDisplay();
  const tool = registerWithImages();
  const context = { showImages: true, state: {} };

  await withCapabilities({ images: "kitty", hyperlinks: true }, async () => {
    const titled = await drawInTui(tool, { source: "a -> b", title: "Request path" });
    const url = pathToFileURL(titled.details.image.path).href;
    const drawn = tool.renderResult(titled, { expanded: false }, theme, context).render(120);
    assert.ok(
      drawn.some((row) => row.includes(`\x1b]8;;${url}`) && row.includes("Request path")),
      "the title is the link",
    );

    // With no title there is nothing to link, so the file name carries it instead.
    const untitled = await drawInTui(tool, { source: "a -> c" });
    const rows = tool
      .renderResult(untitled, { expanded: false }, theme, { showImages: true, state: {} })
      .render(120);
    const name = basename(untitled.details.image.path);
    assert.ok(
      rows.some((row) => row.includes(name) && row.includes("\x1b]8;;")),
      "the file name is the link",
    );
  });
});

test("a terminal that cannot make links gets neither a link nor a file name", async () => {
  const { primeDisplay } = await import("../dist/display.js");
  await primeDisplay();
  const tool = registerWithImages();

  await withCapabilities({ images: "kitty", hyperlinks: false }, async () => {
    const untitled = await drawInTui(tool, { source: "a -> b" });
    const drawn = tool
      .renderResult(untitled, { expanded: false }, theme, { showImages: true, state: {} })
      .render(120)
      .join("\n");
    assert.equal(drawn.includes("\x1b]8;"), false);
    assert.equal(drawn.includes(".png"), false);
  });
});
