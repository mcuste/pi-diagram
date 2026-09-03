import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CommandCancelledError, ImageRenderUnavailableError } from "@mcuste/pi-diagram-core";
import { png } from "../../../test/fixtures/png.mjs";
import { parseRepresentation, renderDiagram } from "../dist/render.js";
import {
  SourceFormatUnavailableError,
  SvgRenderUnavailableError,
  TextRenderUnavailableError,
} from "../dist/runner.js";

const UNICODE_DIAGRAM = "┌────┐\n│ a  │\n└────┘";

const SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>';

function createRenderer({ extended = UNICODE_DIAGRAM, svg = SVG, formatted } = {}) {
  const calls = [];
  return {
    calls,
    renderText({ source, asciiMode, signal }) {
      calls.push({ kind: "text", source, asciiMode, signal });
      const answer = extended;
      if (answer instanceof Error) {
        return Promise.reject(answer);
      }
      return Promise.resolve({ text: answer, version: "v0.8.1-HEAD" });
    },
    renderSvg({ source, profile, signal }) {
      calls.push({ kind: "svg", source, profile, signal });
      if (svg instanceof Error) {
        return Promise.reject(svg);
      }
      return Promise.resolve({ svg, version: "v0.8.1-HEAD" });
    },
    formatSource({ source, signal }) {
      calls.push({ kind: "format", source, signal });
      if (formatted instanceof Error) {
        return Promise.reject(formatted);
      }
      return Promise.resolve(formatted ?? `${source}\n`);
    },
  };
}

function textCalls(renderer) {
  return renderer.calls.filter((call) => call.kind === "text");
}

test("every render mode the schema allows maps onto something this build can draw", () => {
  for (const requested of [undefined, "auto", "image", "unicode"]) {
    assert.equal(parseRepresentation(requested), "unicode");
  }
  assert.equal(parseRepresentation("source"), "source");
});

test("a render mode outside the schema is refused rather than guessed at", () => {
  for (const requested of ["ascii", "svg", "png", "", 3, null]) {
    assert.throws(
      () => parseRepresentation(requested),
      { name: "DiagramSourceError" },
      `${requested}`,
    );
  }
});

test("runtime request parsing rejects unsupported fields before D2 starts", async () => {
  const renderer = createRenderer();
  await assert.rejects(renderDiagram({ source: "a -> b", layout: "elk" }, renderer), {
    name: "DiagramSourceError",
    message: /unsupported field/,
  });
  assert.deepEqual(renderer.calls, []);
});

test("prototype field names are rejected before D2 starts", async () => {
  const renderer = createRenderer();
  await assert.rejects(renderDiagram({ source: "a -> b", toString: true }, renderer), {
    name: "DiagramSourceError",
    message: /unsupported field/,
  });
  assert.deepEqual(renderer.calls, []);
});
test("the profile a call names decides how the picture is drawn", async () => {
  const renderer = createRenderer();
  const rendering = await renderDiagram(
    { source: "a -> b", profile: "docs", formats: ["svg"] },
    renderer,
  );
  const svg = renderer.calls.find((call) => call.kind === "svg");
  assert.equal(svg.profile.name, "docs");
  assert.equal(svg.profile.theme, 1);
  assert.equal(rendering.profile, "docs");
});

test("a call that names no profile is drawn for a conversation", async () => {
  const renderer = createRenderer();
  const rendering = await renderDiagram({ source: "a -> b", formats: ["svg"] }, renderer);
  assert.equal(renderer.calls.find((call) => call.kind === "svg").profile.name, "explain");
  assert.equal(rendering.profile, "explain");
});

test("a profile outside the table is refused before D2 runs", async () => {
  const renderer = createRenderer();
  await assert.rejects(renderDiagram({ source: "a -> b", profile: "pretty" }, renderer), {
    name: "DiagramSourceError",
    message: /is not a profile/,
  });
  assert.deepEqual(renderer.calls, []);
});

test("malformed optional fields are refused instead of treated as absent", async () => {
  const renderer = createRenderer();
  for (const request of [
    { source: "a -> b", title: null },
    { source: "a -> b", render: 1 },
    { source: "a -> b", save: { dir: "docs", basename: null }, cwd: process.cwd() },
  ]) {
    await assert.rejects(renderDiagram(request, renderer), { name: "DiagramSourceError" });
  }
  assert.deepEqual(renderer.calls, []);
});

test("an image request prepares PNG while Unicode remains the text fallback", async () => {
  const renderer = createRenderer();
  const rasterizer = createRasterizer();
  const rendering = await renderDiagram(
    { source: "a -> b", render: "image" },
    renderer,
    rasterizer,
  );
  assert.equal(rendering.display.kind, "unicode");
  assert.equal(rendering.image?.widthPx, 800);
  assert.equal(rendering.image?.heightPx, 600);
  assert.equal(textCalls(renderer)[0].asciiMode, "extended");
  assert.deepEqual(
    renderer.calls.map((call) => call.kind),
    ["text", "svg"],
  );
  assert.equal(rasterizer.calls.length, 1);
});

test("source mode selects normalized source without skipping the generated bundle", async () => {
  const renderer = createRenderer();
  const rasterizer = createRasterizer();
  const rendering = await renderDiagram(
    { source: " a -> b \r\n", render: "source" },
    renderer,
    rasterizer,
  );
  assert.equal(rendering.display.kind, "source");
  assert.equal(rendering.display.content, "a -> b");
  assert.equal(rendering.d2Version, "v0.8.1-HEAD");
  assert.ok(rendering.image);
  assert.deepEqual(
    renderer.calls.map((call) => call.kind),
    ["text", "svg"],
  );
});

test("the source that was drawn comes back for the expanded row", async () => {
  const renderer = createRenderer();
  const rendering = await renderDiagram({ source: " a -> b \r\n" }, renderer);
  assert.equal(rendering.source, "a -> b");
  assert.notEqual(rendering.display.content, rendering.source);
  assert.deepEqual(rendering.diagnostics, []);
});

test("Unicode failure keeps the PNG and falls back to source, never ASCII", async () => {
  const renderer = createRenderer({ extended: new TextRenderUnavailableError("beta renderer") });
  const rendering = await renderDiagram({ source: "a -> b" }, renderer, createRasterizer());
  assert.equal(rendering.display.kind, "source");
  assert.equal(rendering.display.content, "a -> b");
  assert.ok(rendering.image);
  assert.deepEqual(
    textCalls(renderer).map((call) => call.asciiMode),
    ["extended"],
  );
});

test("text and SVG failures reject when no usable representation remains", async () => {
  const textFailure = new TextRenderUnavailableError("beta renderer", [
    { code: "D2_RENDER", message: "cannot draw this shape as text", line: 2 },
  ]);
  await assert.rejects(
    renderDiagram(
      { source: "a -> b" },
      createRenderer({ extended: textFailure, svg: new SvgRenderUnavailableError("unsafe SVG") }),
    ),
    {
      name: "TextRenderUnavailableError",
      message: /beta and cannot draw every diagram.*render: "source"/s,
    },
  );
});

test("source mode remains usable when text and SVG rendering fail", async () => {
  const rendering = await renderDiagram(
    { source: " a -> b \r\n", render: "source" },
    createRenderer({
      extended: new TextRenderUnavailableError("beta renderer"),
      svg: new SvgRenderUnavailableError("unsafe SVG"),
    }),
  );
  assert.equal(rendering.display.kind, "source");
  assert.equal(rendering.display.content, "a -> b");
  assert.equal(rendering.image, undefined);
  assert.match(rendering.notes.join("\n"), /unsafe SVG.*SVG and PNG could not be generated/s);
});

test("a required SVG failure writes no partial artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-render-"));
  try {
    await assert.rejects(
      renderDiagram(
        {
          source: "a -> b",
          title: "Flow",
          formats: ["source", "svg"],
          save: { dir: "docs" },
          cwd: root,
        },
        createRenderer({ svg: new SvgRenderUnavailableError("unsafe SVG") }),
      ),
      { name: "SvgRenderUnavailableError" },
    );
    await assert.rejects(readFile(join(root, "docs/flow.d2"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(join(root, "docs/flow.svg"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source problems are reported before D2 is ever started", async () => {
  const renderer = createRenderer();
  await assert.rejects(renderDiagram({ source: "a -> b\n...@/etc/hosts" }, renderer), {
    name: "DiagramSourceError",
    message: /D2_IMPORT/,
  });
  assert.deepEqual(renderer.calls, [], "D2 ran on source that had not been checked");
});

test("cancellation and unexpected failures are passed through untouched", async () => {
  const renderer = createRenderer({ extended: new Error("host went away") });
  await assert.rejects(renderDiagram({ source: "a -> b" }, renderer), {
    message: "host went away",
  });
  assert.equal(textCalls(renderer).length, 1, "retried something that was not a renderer limit");
});

test("the abort signal reaches the renderer", async () => {
  const renderer = createRenderer();
  const controller = new AbortController();
  await renderDiagram({ source: "a -> b", signal: controller.signal }, renderer);
  assert.equal(textCalls(renderer)[0].signal, controller.signal);
});

test("the drawing is measured, and the title is cleaned up", async () => {
  const renderer = createRenderer();
  const rendering = await renderDiagram(
    { source: "a -> b", title: "  Request   path\n" },
    renderer,
  );
  assert.equal(rendering.title, "Request path");
  assert.equal(rendering.lineCount, 3);
  assert.equal(rendering.widthCells, 6);
  assert.match(rendering.sourceHash, /^[0-9a-f]{64}$/);
});

test("a drawing too big for a transcript is refused with advice to split it", async () => {
  const tall = createRenderer({ extended: `${"┌────┐\n".repeat(400)}└────┘` });
  await assert.rejects(renderDiagram({ source: "a -> b" }, tall), {
    name: "DiagramSourceError",
    message: /split it into several diagrams.*D2_TOO_LARGE/s,
  });

  const wide = createRenderer({ extended: `┌${"─".repeat(500)}┐` });
  await assert.rejects(renderDiagram({ source: "a -> b" }, wide), {
    name: "DiagramSourceError",
    message: /D2_TOO_LARGE/,
  });
});

test("an oversized render never commits repository artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-render-"));
  try {
    const tall = createRenderer({ extended: `${"┌────┐\n".repeat(400)}└────┘` });
    await assert.rejects(
      renderDiagram(
        {
          source: "a -> b",
          title: "Flow",
          formats: ["source"],
          save: { dir: "docs" },
          cwd: root,
        },
        tall,
      ),
      { name: "DiagramSourceError", message: /D2_TOO_LARGE/ },
    );
    await assert.rejects(readFile(join(root, "docs/flow.d2"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saving is refused before D2 runs, because a bad path costs nothing to catch", async () => {
  const renderer = createRenderer();
  await assert.rejects(
    renderDiagram(
      { source: "a -> b", title: "T", save: { dir: "../escape" }, cwd: "/tmp" },
      renderer,
    ),
    { name: "DiagramSourceError" },
  );
  assert.deepEqual(renderer.calls, [], "D2 ran for a request that could never be saved");
});

test("every diagram prepares Unicode, SVG, and PNG", async () => {
  const renderer = createRenderer();
  const rasterizer = createRasterizer();
  const rendering = await renderDiagram({ source: "a -> b" }, renderer, rasterizer);
  assert.deepEqual(
    renderer.calls.map((call) => call.kind),
    ["text", "svg"],
  );
  assert.equal(rasterizer.calls.length, 1);
  assert.ok(rendering.image?.path.endsWith(".png"));
});

test("a text failure still saves the SVG and shows the source instead", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-render-"));
  try {
    const failure = new TextRenderUnavailableError("beta renderer", [
      { code: "D2_RENDER", message: "cannot draw this shape as text", line: 2 },
    ]);
    const renderer = createRenderer({ extended: failure, standard: failure });
    const rendering = await renderDiagram(
      {
        source: "a -> b",
        title: "Flow",
        formats: ["source", "svg", "txt"],
        save: { dir: "docs/diagrams" },
        cwd: root,
      },
      renderer,
    );

    assert.equal(rendering.display.kind, "source");
    assert.equal(rendering.display.content, "a -> b");
    assert.deepEqual(
      rendering.saved.map((artifact) => artifact.path),
      ["docs/diagrams/flow.d2", "docs/diagrams/flow.svg"],
    );
    assert.ok(rendering.notes.some((note) => note.includes("No .txt was written")));
    assert.ok(rendering.notes.some((note) => note.includes("shown as source")));
    // Why the text is missing, for the expanded row.
    assert.deepEqual(rendering.diagnostics, failure.diagnostics);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a saved .d2 holds what d2 fmt wrote, not what the model typed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-render-"));
  try {
    const renderer = createRenderer({ formatted: "a -> b\n" });
    await renderDiagram(
      { source: "a->b", title: "Flow", formats: ["source"], save: { dir: "docs" }, cwd: root },
      renderer,
    );
    assert.equal(await readFile(join(root, "docs/flow.d2"), "utf8"), "a -> b\n");
    assert.deepEqual(
      renderer.calls.filter((call) => call.kind === "format").map((call) => call.source),
      ["a->b"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a source formatter that is unavailable saves the safe source", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-render-"));
  try {
    const renderer = createRenderer({
      formatted: new SourceFormatUnavailableError("fmt is unavailable"),
    });
    await renderDiagram(
      { source: "a->b", title: "Flow", formats: ["source"], save: { dir: "docs" }, cwd: root },
      renderer,
    );
    assert.equal(await readFile(join(root, "docs/flow.d2"), "utf8"), "a->b\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation during formatting does not write the repository fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-render-"));
  try {
    const controller = new AbortController();
    const renderer = createRenderer();
    renderer.formatSource = () => {
      controller.abort();
      return Promise.reject(new CommandCancelledError("d2"));
    };
    await assert.rejects(
      renderDiagram(
        {
          source: "a -> b",
          title: "Flow",
          formats: ["source"],
          save: { dir: "docs" },
          cwd: root,
          signal: controller.signal,
        },
        renderer,
      ),
      { name: "CommandCancelledError" },
    );
    await assert.rejects(readFile(join(root, "docs/flow.d2"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("formatting cannot smuggle anything past the safe subset", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-render-"));
  try {
    const renderer = createRenderer({ formatted: "s: { icon: /etc/hosts }\n" });
    await renderDiagram(
      { source: "a -> b", title: "Flow", formats: ["source"], save: { dir: "docs" }, cwd: root },
      renderer,
    );
    assert.equal(await readFile(join(root, "docs/flow.d2"), "utf8"), "a -> b\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source mode still writes a txt when one is asked for", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-render-"));
  try {
    const renderer = createRenderer();
    const rendering = await renderDiagram(
      {
        source: "a -> b",
        title: "Flow",
        render: "source",
        formats: ["txt"],
        save: { dir: "docs/diagrams" },
        cwd: root,
      },
      renderer,
    );
    assert.equal(rendering.display.kind, "source");
    assert.deepEqual(
      rendering.saved.map((artifact) => artifact.path),
      ["docs/diagrams/flow.txt"],
    );
    assert.equal(
      await readFile(join(root, "docs/diagrams/flow.txt"), "utf8"),
      `${UNICODE_DIAGRAM}\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const PNG_BYTES = png();

/** Stands in for resvg. Records what it was handed, and can fail the way resvg would. */
function createRasterizer({ png = PNG_BYTES, systemFonts = false, error } = {}) {
  const calls = [];
  return {
    calls,
    rasterize({ svg, signal }) {
      calls.push({ svg, signal });
      if (error !== undefined) {
        return Promise.reject(error);
      }
      return Promise.resolve({ png, widthPx: 800, heightPx: 600, systemFonts });
    },
  };
}

test("the generated PNG is kept with Unicode as its fallback", async () => {
  const renderer = createRenderer();
  const rasterizer = createRasterizer();
  const rendering = await renderDiagram({ source: "a -> b" }, renderer, rasterizer);

  assert.equal(rendering.image?.widthPx, 800);
  assert.equal(rendering.image?.heightPx, 600);
  assert.ok(rendering.image?.path.endsWith(".png"), rendering.image?.path);
  assert.equal(await readFile(rendering.image.path, "utf8"), PNG_BYTES.toString("utf8"));
  assert.equal(rendering.display.kind, "unicode");
  assert.equal(rendering.display.content, UNICODE_DIAGRAM);
  assert.equal(rasterizer.calls[0].svg, SVG);
});

test("text display overrides do not skip PNG generation", async () => {
  for (const render of ["unicode", "source"]) {
    const rasterizer = createRasterizer();
    const rendering = await renderDiagram(
      { source: "a -> b", render },
      createRenderer(),
      rasterizer,
    );
    assert.ok(rendering.image, render);
    assert.equal(rasterizer.calls.length, 1, render);
  }
});

test("an image that cannot be drawn leaves the diagram working, with a note", async () => {
  const rasterizer = createRasterizer({
    error: new ImageRenderUnavailableError("The rasterizer is missing."),
  });
  const rendering = await renderDiagram({ source: "a -> b" }, createRenderer(), rasterizer);

  assert.equal(rendering.image, undefined);
  assert.equal(rendering.display.kind, "unicode");
  assert.match(rendering.notes.join("\n"), /rasterizer is missing.*PNG could not be generated/s);
});

test("a failure that is not an image problem is not swallowed", async () => {
  await assert.rejects(
    renderDiagram(
      { source: "a -> b" },
      createRenderer(),
      createRasterizer({ error: new TypeError("bug") }),
    ),
    { name: "TypeError" },
  );
});

test("an optional SVG failure preserves a usable text diagram", async () => {
  const rendering = await renderDiagram(
    { source: "a -> b" },
    createRenderer({ svg: new SvgRenderUnavailableError("unsafe SVG") }),
  );
  assert.equal(rendering.display.kind, "unicode");
  assert.equal(rendering.image, undefined);
  assert.match(rendering.notes.join("\n"), /unsafe SVG.*SVG and PNG could not be generated/s);
});

test("labels the diagram's own font cannot draw are reported", async () => {
  const rendering = await renderDiagram(
    { source: "a -> b" },
    createRenderer(),
    createRasterizer({ systemFonts: true }),
  );
  assert.match(rendering.notes.join("\n"), /fonts installed on this machine/);
});

test("measured width uses terminal cells and source mode honours cancellation", async () => {
  const wide = createRenderer({ extended: "表" });
  assert.equal((await renderDiagram({ source: "a -> b" }, wide, createRasterizer())).widthCells, 2);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    renderDiagram(
      { source: "a -> b", render: "source", signal: controller.signal },
      createRenderer(),
    ),
    { name: "CommandCancelledError" },
  );
});

test("a png reaches the repository only when it is asked for", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-render-"));
  try {
    const kept = await renderDiagram(
      {
        source: "a -> b",
        title: "Flow",
        formats: ["source"],
        save: { dir: "docs" },
        cwd: root,
      },
      createRenderer(),
      createRasterizer(),
    );
    assert.deepEqual(
      kept.saved.map((artifact) => artifact.path),
      ["docs/flow.d2"],
    );
    // PNG stays private unless requested.
    assert.ok(kept.image?.path.startsWith(tmpdir()), kept.image?.path);

    const saved = await renderDiagram(
      {
        source: "a -> b",
        title: "Flow",
        formats: ["png"],
        save: { dir: "docs" },
        cwd: root,
      },
      createRenderer(),
      createRasterizer(),
    );
    assert.deepEqual(
      saved.saved.map((artifact) => artifact.path),
      ["docs/flow.png"],
    );
    assert.deepEqual(await readFile(join(root, "docs/flow.png")), PNG_BYTES);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a png that could not be drawn is reported rather than written empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-render-"));
  try {
    const rendering = await renderDiagram(
      {
        source: "a -> b",
        title: "Flow",
        formats: ["png"],
        save: { dir: "docs" },
        cwd: root,
      },
      createRenderer(),
      createRasterizer({ error: new ImageRenderUnavailableError("no rasterizer") }),
    );
    assert.deepEqual(rendering.saved, []);
    assert.match(rendering.notes.join("\n"), /No \.png was written/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
