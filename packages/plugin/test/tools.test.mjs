import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { PROFILE_NAMES, TextRenderUnavailableError } from "@mcuste/pi-diagram-d2";
import { Value } from "typebox/value";
import { png } from "../../../test/fixtures/png.mjs";
import { primeDiagramDescription, registerDiagramTools } from "../dist/tools.js";

const UNICODE_DIAGRAM = "┌────┐\n│ a  │\n└────┘";
const TOOL_DESCRIPTION = (
  await readFile(new URL("../src/tool-description.md", import.meta.url), "utf8")
).trimEnd();

await primeDiagramDescription();

function register(renderer, rasterizer) {
  const tools = new Map();
  registerDiagramTools(
    {
      registerTool(definition) {
        tools.set(definition.name, definition);
      },
    },
    {
      ...(renderer === undefined ? {} : { renderer }),
      ...(rasterizer === undefined ? {} : { rasterizer }),
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

test("the tool description is loaded from Markdown", () => {
  assert.equal(diagram.description, TOOL_DESCRIPTION);
});

test("profile selection appears before D2 syntax", () => {
  assert.ok(diagram.description.indexOf("## Selection") < diagram.description.indexOf("## Syntax"));
});

test("the description shows the model the syntax and selection rules it needs", () => {
  for (const profile of PROFILE_NAMES) {
    assert.match(diagram.description, new RegExp(`- \`${profile}\`:`), profile);
  }
  for (const example of [
    "client -> gateway",
    "sequence_diagram",
    "shape: class",
    "sql_table",
    "c4-person",
    "callbacks",
    "affected code",
    "shape: image",
  ]) {
    assert.ok(diagram.description.includes(example), example);
  }
});

test("source is the only required field", () => {
  assert.ok(accepts({ source: "a -> b" }));
  assert.ok(!accepts({}));
  assert.ok(!accepts({ source: "" }));
});

test("every documented field and profile is accepted", () => {
  for (const profile of PROFILE_NAMES) {
    assert.ok(
      accepts({
        source: "a -> b",
        title: "Request lifecycle",
        profile,
        render: "unicode",
        formats: ["source", "svg"],
        save: { dir: "docs/diagrams", basename: "request-lifecycle" },
      }),
      profile,
    );
  }
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

test("details carry Unicode and PNG for the result renderer", async () => {
  const result = await run(register(createRenderer(), createRasterizer()), {
    source: "a -> b",
    title: "Request path",
    profile: "architecture",
    render: "auto",
  });
  const { image, sourceHash, ...rest } = result.details;
  assert.match(sourceHash, /^[0-9a-f]{64}$/);
  assert.ok(image.path.endsWith(".png"));
  assert.equal(image.widthPx, 800);
  assert.equal(image.heightPx, 600);
  assert.deepEqual(rest, {
    language: "d2",
    title: "Request path",
    profile: "architecture",
    requested: "auto",
    renderedAs: "unicode",
    textPreview: UNICODE_DIAGRAM,
    source: "a -> b",
    lineCount: 3,
    widthCells: 6,
    d2Version: "v0.8.1-HEAD",
  });
});

test("Unicode failure keeps PNG and falls back to source, never ASCII", async () => {
  const renderer = createRenderer(new TextRenderUnavailableError("beta renderer"));
  const result = await run(register(renderer, createRasterizer()), { source: "a -> b" });
  assert.equal(result.details.renderedAs, "source");
  assert.ok(result.details.image);
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

const PNG_BYTES = png();

function createRasterizer({ widthPx = 800, heightPx = 600 } = {}) {
  return {
    rasterize() {
      return Promise.resolve({
        png: png({ width: widthPx, height: heightPx }),
        widthPx,
        heightPx,
        systemFonts: false,
      });
    },
  };
}

function registerWithRasterizer() {
  return register(createRenderer(), createRasterizer());
}

const theme = { fg: (_color, text) => text };

/** Prevent host terminal capabilities from making image tests environment-dependent. */
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

function drawInTui(diagram, parameters) {
  return diagram.execute("call-1", parameters, undefined, () => {}, {
    cwd: process.cwd(),
    mode: "tui",
  });
}

function drawInOmp(diagram, parameters, context = {}) {
  return diagram.execute("call-1", parameters, undefined, () => {}, {
    cwd: process.cwd(),
    hasUI: true,
    ...context,
  });
}

test("the waiting row names the diagram, not its source", async () => {
  const { primeDisplay } = await import("@mcuste/pi-diagram-display");
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

test("every host mode receives Unicode, SVG, and PNG", async () => {
  const tool = registerWithRasterizer();
  for (const mode of ["tui", "print", "rpc", undefined]) {
    const result = await tool.execute("call-1", { source: "a -> b" }, undefined, () => {}, {
      cwd: process.cwd(),
      mode,
    });
    assert.equal(result.details.renderedAs, "unicode", String(mode));
    assert.ok(result.details.image?.path.endsWith(".png"), String(mode));
  }
});

test("the collapsed default stays Unicode where images are supported", async () => {
  const { primeDisplay } = await import("@mcuste/pi-diagram-display");
  await primeDisplay();
  const tool = registerWithRasterizer();
  await withCapabilities({ images: "kitty" }, async () => {
    const result = await drawInTui(tool, { source: "a -> b" });
    const drawn = tool
      .renderResult(result, { expanded: false }, theme, { showImages: true, state: {} })
      .render(120)
      .join("\n");
    assert.match(drawn, /┌/);
    assert.equal(drawn.includes("\x1b_G"), false);
    assert.match(drawn, /Ctrl\+O: view PNG/);
  });
});

test("an explicit image request shows a compact image", async () => {
  const { primeDisplay } = await import("@mcuste/pi-diagram-display");
  await primeDisplay();
  const tool = registerWithRasterizer();
  await withCapabilities({ images: "kitty" }, async () => {
    const result = await drawInTui(tool, { source: "a -> b", render: "image" });
    const drawn = tool
      .renderResult(result, { expanded: false }, theme, { showImages: true, state: {} })
      .render(120)
      .join("\n");
    assert.ok(drawn.includes("\x1b_G"), drawn);
    assert.match(drawn, /Ctrl\+O: zoom image/);
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
      `import piDiagram from ${JSON.stringify(new URL("../dist/extension.js", import.meta.url).href)};`,
      "const tools = new Map();",
      "await piDiagram({ registerTool(tool) { tools.set(tool.name, tool); } });",
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
  const { primeDisplay } = await import("@mcuste/pi-diagram-display");
  await primeDisplay();
  const tool = registerWithRasterizer();
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
  assert.match(text, /^Drew the diagram\./);
  assert.match(text, /not repeated here/);
});

test("the diagram is in the content when the host has to print it", async () => {
  const tool = registerWithRasterizer();
  for (const mode of ["print", "rpc", undefined]) {
    const result = await tool.execute("call-1", { source: "a -> b" }, undefined, () => {}, {
      cwd: process.cwd(),
      mode,
    });
    assert.match(result.content[0].text, /┌/, String(mode));
  }
});

test("Ctrl+O replaces Unicode with the PNG zoom and adds details", async () => {
  const { primeDisplay } = await import("@mcuste/pi-diagram-display");
  await primeDisplay();
  const tool = registerWithRasterizer();
  await withCapabilities({ images: "kitty" }, async () => {
    const result = await drawInTui(tool, { source: "a -> b" });
    const context = { showImages: true, state: {} };
    const collapsed = tool
      .renderResult(result, { expanded: false }, theme, context)
      .render(120)
      .join("\n");
    assert.match(collapsed, /┌/);
    assert.equal(collapsed.includes("\x1b_G"), false);
    assert.match(collapsed, /Ctrl\+O: view PNG/);
    assert.doesNotMatch(collapsed, /a -> b/);

    const expanded = tool
      .renderResult(result, { expanded: true }, theme, context)
      .render(120)
      .join("\n");
    assert.ok(expanded.includes("\x1b_G"), expanded);
    assert.match(expanded, /Ctrl\+O: show Unicode/);
    assert.match(
      expanded,
      /Default view Unicode; shown as an image, profile explain, D2 v0\.8\.1-HEAD/,
    );
    assert.match(expanded, /a -> b/);
  });
});

test("explicit render modes keep their selected display across expansion", async () => {
  const { primeDisplay } = await import("@mcuste/pi-diagram-display");
  await primeDisplay();
  const tool = registerWithRasterizer();

  await withCapabilities({ images: "kitty" }, async () => {
    for (const [render, expected] of [
      ["unicode", { image: false, label: "shown as box drawing", hint: undefined }],
      ["source", { image: false, label: "shown as D2 source", hint: undefined }],
      ["image", { image: true, label: "shown as an image", hint: "Ctrl+O: fit image" }],
    ]) {
      const result = await drawInTui(tool, { source: "a -> b", render });
      const drawn = tool
        .renderResult(result, { expanded: true }, theme, { showImages: true, state: {} })
        .render(120)
        .join("\n");
      assert.equal(drawn.includes("\x1b_G"), expected.image, render);
      assert.match(drawn, new RegExp(expected.label), render);
      if (expected.hint === undefined) {
        assert.doesNotMatch(drawn, /Ctrl\+O:/, render);
      } else {
        assert.equal(drawn.includes(expected.hint), true, render);
      }
    }
  });
});

test("expanded tall PNGs fill the terminal width", async () => {
  const { primeDisplay } = await import("@mcuste/pi-diagram-display");
  await primeDisplay();
  const tool = register(createRenderer(), createRasterizer({ heightPx: 2400 }));

  await withCapabilities({ images: "kitty" }, async () => {
    const result = await drawInTui(tool, { source: "a -> b" });
    const expanded = tool
      .renderResult(result, { expanded: true }, theme, { showImages: true, state: {} })
      .render(120)
      .join("\n");
    const command = expanded.split("\n").find((line) => line.includes("\x1b_G"));
    assert.ok(command, expanded);
    assert.match(command, /(?:^|,)c=118(?:,|;)/);
    assert.match(command, /(?:^|,)r=177(?:,|;)/);
  });
});

test("an explicit image request falls back when inline images are disabled", async () => {
  const { primeDisplay } = await import("@mcuste/pi-diagram-display");
  await primeDisplay();
  const tool = registerWithRasterizer();
  const result = await drawInTui(tool, { source: "a -> b", render: "image" });

  await withCapabilities({ images: "kitty" }, () => {
    const shown = tool
      .renderResult(result, { expanded: false }, theme, { showImages: true, state: {} })
      .render(120)
      .join("\n");
    assert.ok(shown.includes("\x1b_G"), shown);

    const disabled = tool
      .renderResult(result, { expanded: false }, theme, { showImages: false, state: {} })
      .render(120)
      .join("\n");
    assert.match(disabled, /┌/);
    assert.match(disabled, /Inline images are disabled in this view\./);
  });
});

test("a missing PNG falls back to Unicode without image details or controls", async () => {
  const { primeDisplay } = await import("@mcuste/pi-diagram-display");
  await primeDisplay();
  const tool = registerWithRasterizer();
  const result = await drawInTui(tool, {
    source: "a -> b",
    title: "Request path",
    render: "image",
  });
  await unlink(result.details.image.path);

  await withCapabilities({ images: "kitty", hyperlinks: true }, () => {
    const drawn = tool
      .renderResult(result, { expanded: true }, theme, { showImages: true, state: {} })
      .render(120)
      .join("\n");
    assert.match(drawn, /┌/);
    assert.equal(drawn.includes("\x1b_G"), false);
    assert.equal(drawn.includes("\x1b]8;"), false);
    assert.doesNotMatch(drawn, /shown as an image|Ctrl\+O:/);
    assert.match(drawn, /Requested image; shown as box drawing/);
  });
});

test("OMP opens a fitted PNG overlay without purging other images", async () => {
  const { primeDisplay } = await import("@mcuste/pi-diagram-display");
  await primeDisplay();
  const text = ["┌────┐", ...Array.from({ length: 29 }, (_, index) => `row ${index + 2}`)].join(
    "\n",
  );
  const tool = register(createRenderer(text), createRasterizer());
  let expanded = false;
  let tick;
  const overlays = [];
  const ui = {
    getToolsExpanded: () => expanded,
    setToolsExpanded: (value) => {
      expanded = value;
    },
    custom: (factory, options) => {
      const deferred = Promise.withResolvers();
      overlays.push({ factory, options, ...deferred });
      return deferred.promise;
    },
  };
  const result = await withCapabilities({ images: "kitty" }, () =>
    drawInOmp(tool, { source: "a -> b" }, { ui, setInterval: (callback) => (tick = callback) }),
  );

  await withCapabilities({ images: "kitty", hyperlinks: true }, async () => {
    const transcript = tool
      .renderResult(result, { expanded: false }, theme, { source: "a -> b" })
      .render(120)
      .join("\n");
    assert.match(transcript, /row 30/);
    assert.match(transcript, /Ctrl\+O: view latest PNG/);
    assert.equal(overlays.length, 0);

    expanded = true;
    tick();
    const shown = overlays.at(-1);
    assert.deepEqual(shown.options, {
      overlay: true,
      overlayOptions: {
        fullscreen: true,
        width: "100%",
        maxHeight: "100%",
        margin: 0,
      },
    });
    let cleared = 0;
    const overlay = shown.factory(
      { terminal: { rows: 40 }, clearInlineImages: () => cleared++ },
      theme,
      { matches: (data, action) => data === "\x0f" && action === "app.tools.expand" },
      shown.resolve,
    );
    const lines = overlay.render(120);
    const png = lines.join("\n");
    assert.match(png, /Ctrl\+O or Esc to close/);
    assert.doesNotMatch(png, /cannot display inline images/);
    assert.ok(lines.length <= 40, String(lines.length));

    overlay.handleInput("\x0f");
    await shown.promise;
    await Promise.resolve();
    assert.equal(cleared, 0);
    assert.equal(expanded, false);
  });
});

test("OMP opens the most recent diagram overlay", async () => {
  const { primeDisplay } = await import("@mcuste/pi-diagram-display");
  await primeDisplay();
  const tool = registerWithRasterizer();
  let expanded = false;
  let tick;
  const overlays = [];
  const ui = {
    getToolsExpanded: () => expanded,
    setToolsExpanded: (value) => {
      expanded = value;
    },
    custom: (factory, options) => {
      const deferred = Promise.withResolvers();
      overlays.push({ factory, options, ...deferred });
      return deferred.promise;
    },
  };
  const context = { ui, setInterval: (callback) => (tick = callback) };
  await drawInOmp(tool, { source: "a -> b", title: "First diagram" }, context);
  await drawInOmp(tool, { source: "a -> b", title: "Latest diagram" }, context);

  await withCapabilities({ images: "kitty" }, async () => {
    expanded = true;
    tick();
    const shown = overlays.at(-1);
    const overlay = shown.factory(
      { terminal: { rows: 40 } },
      theme,
      { matches: () => false },
      shown.resolve,
    );
    assert.match(overlay.render(120).join("\n"), /Latest diagram/);
    overlay.handleInput("\x1b");
    await shown.promise;
  });
});

test("unsupported terminals report the PNG limitation only after Ctrl+O", async () => {
  const { primeDisplay } = await import("@mcuste/pi-diagram-display");
  await primeDisplay();
  const tool = registerWithRasterizer();
  const result = await drawInTui(tool, { source: "a -> b" });
  assert.ok(result.details.image);
  assert.equal(result.details.notes, undefined);

  await withCapabilities({ images: null }, () => {
    const context = { showImages: true, state: {} };
    const collapsed = tool
      .renderResult(result, { expanded: false }, theme, context)
      .render(120)
      .join("\n");
    assert.match(collapsed, /┌/);
    assert.doesNotMatch(collapsed, /cannot display inline images/);

    const expanded = tool
      .renderResult(result, { expanded: true }, theme, context)
      .render(120)
      .join("\n");
    assert.match(expanded, /┌/);
    assert.doesNotMatch(expanded, /\.png/);
    assert.match(expanded, /This terminal cannot display inline images\./);
  });

  await withCapabilities({ images: "kitty" }, () => {
    const expanded = tool
      .renderResult(result, { expanded: true }, theme, { showImages: true, state: {} })
      .render(120)
      .join("\n");
    assert.ok(expanded.includes("\x1b_G"), expanded);
  });
});

test("the drawn diagram links to its file, so a click opens it for zooming", async () => {
  const { primeDisplay } = await import("@mcuste/pi-diagram-display");
  const { pathToFileURL } = await import("node:url");
  const { basename } = await import("node:path");
  await primeDisplay();
  const tool = registerWithRasterizer();
  const context = { showImages: true, state: {} };

  await withCapabilities({ images: "kitty", hyperlinks: true }, async () => {
    const titled = await drawInTui(tool, { source: "a -> b", title: "Request path" });
    const url = pathToFileURL(titled.details.image.path).href;
    const drawn = tool.renderResult(titled, { expanded: true }, theme, context).render(120);
    assert.ok(
      drawn.some((row) => row.includes(`\x1b]8;;${url}`) && row.includes("Request path")),
      "the title is the link",
    );

    // Untitled diagrams link their file name.
    const untitled = await drawInTui(tool, { source: "a -> c" });
    const rows = tool
      .renderResult(untitled, { expanded: true }, theme, { showImages: true, state: {} })
      .render(120);
    const name = basename(untitled.details.image.path);
    assert.ok(
      rows.some((row) => row.includes(name) && row.includes("\x1b]8;;")),
      "the file name is the link",
    );
  });
});

test("a terminal that cannot make links gets neither a link nor a file name", async () => {
  const { primeDisplay } = await import("@mcuste/pi-diagram-display");
  await primeDisplay();
  const tool = registerWithRasterizer();

  await withCapabilities({ images: "kitty", hyperlinks: false }, async () => {
    const untitled = await drawInTui(tool, { source: "a -> b" });
    const drawn = tool
      .renderResult(untitled, { expanded: true }, theme, { showImages: true, state: {} })
      .render(120)
      .join("\n");
    assert.equal(drawn.includes("\x1b]8;"), false);
    assert.equal(drawn.includes(".png"), false);
  });
});
