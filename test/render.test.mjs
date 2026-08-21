import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TextRenderUnavailableError } from "../dist/d2/runner.js";
import { ImageRenderUnavailableError } from "../dist/raster.js";
import { parseRepresentation, renderDiagram } from "../dist/render.js";

const UNICODE_DIAGRAM = "┌────┐\n│ a  │\n└────┘";
const ASCII_DIAGRAM = "+----+\n| a  |\n+----+";

const SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>';

/** Answers with a diagram, or fails, per ASCII mode. Records what it was asked for. */
function createRenderer({ extended = UNICODE_DIAGRAM, standard = ASCII_DIAGRAM, svg = SVG } = {}) {
  const calls = [];
  return {
    calls,
    renderText({ source, asciiMode, signal }) {
      calls.push({ kind: "text", source, asciiMode, signal });
      const answer = asciiMode === "standard" ? standard : extended;
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
  };
}

function textCalls(renderer) {
  return renderer.calls.filter((call) => call.kind === "text");
}

test("every render mode the schema allows maps onto something this build can draw", () => {
  for (const requested of [undefined, "auto", "image", "unicode"]) {
    assert.equal(parseRepresentation(requested), "unicode");
  }
  assert.equal(parseRepresentation("ascii"), "ascii");
  assert.equal(parseRepresentation("source"), "source");
});

test("a render mode outside the schema is refused rather than guessed at", () => {
  for (const requested of ["svg", "png", "", 3, null]) {
    assert.throws(
      () => parseRepresentation(requested),
      { name: "DiagramSourceError" },
      `${requested}`,
    );
  }
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

test("an image request is answered with text where the host cannot show one", async () => {
  const renderer = createRenderer();
  const rendering = await renderDiagram({ source: "a -> b", render: "image" }, renderer);
  assert.equal(rendering.renderedAs, "unicode");
  assert.equal(rendering.image, undefined);
  assert.equal(textCalls(renderer)[0].asciiMode, "extended");
  // Nothing was rasterized, so no SVG was asked for either.
  assert.equal(
    renderer.calls.some((call) => call.kind === "svg"),
    false,
  );
});

test("source mode returns the normalized source without running D2", async () => {
  const renderer = createRenderer();
  const rendering = await renderDiagram({ source: " a -> b \r\n", render: "source" }, renderer);
  assert.equal(rendering.renderedAs, "source");
  assert.equal(rendering.text, "a -> b");
  assert.equal(rendering.d2Version, undefined);
  assert.deepEqual(renderer.calls, []);
});

test("ascii mode asks for standard characters", async () => {
  const renderer = createRenderer();
  const rendering = await renderDiagram({ source: "a -> b", render: "ascii" }, renderer);
  assert.equal(rendering.renderedAs, "ascii");
  assert.equal(rendering.text, ASCII_DIAGRAM);
  assert.deepEqual(
    textCalls(renderer).map((call) => call.asciiMode),
    ["standard"],
  );
});

test("Unicode that cannot be drawn is retried once in plain ASCII", async () => {
  const renderer = createRenderer({ extended: new TextRenderUnavailableError("beta renderer") });
  const rendering = await renderDiagram({ source: "a -> b" }, renderer);
  assert.equal(rendering.renderedAs, "ascii");
  assert.equal(rendering.text, ASCII_DIAGRAM);
  assert.deepEqual(rendering.notes, [
    "Unicode output failed, so this diagram is drawn in plain ASCII.",
  ]);
  assert.deepEqual(
    textCalls(renderer).map((call) => call.asciiMode),
    ["extended", "standard"],
  );
});

test("when neither mode works the user is told, and no other diagram is invented", async () => {
  const renderer = createRenderer({
    extended: new TextRenderUnavailableError("beta renderer"),
    standard: new TextRenderUnavailableError("beta renderer"),
  });
  await assert.rejects(renderDiagram({ source: "a -> b" }, renderer), {
    name: "TextRenderUnavailableError",
    message: /beta and cannot draw every diagram.*render: "source"/s,
  });
  assert.equal(textCalls(renderer).length, 2, "gave up after one retry");
});

test("a request for plain ASCII is not retried, because there is nothing to fall back to", async () => {
  const renderer = createRenderer({ standard: new TextRenderUnavailableError("beta renderer") });
  await assert.rejects(renderDiagram({ source: "a -> b", render: "ascii" }, renderer), {
    name: "TextRenderUnavailableError",
  });
  assert.equal(textCalls(renderer).length, 1);
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

test("an SVG is only rendered when it is going to be written", async () => {
  const renderer = createRenderer();
  await renderDiagram({ source: "a -> b" }, renderer);
  assert.deepEqual(
    renderer.calls.map((call) => call.kind),
    ["text"],
  );
});

test("a text failure still saves the SVG and shows the source instead", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-render-"));
  try {
    const renderer = createRenderer({
      extended: new TextRenderUnavailableError("beta renderer"),
      standard: new TextRenderUnavailableError("beta renderer"),
    });
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

    assert.equal(rendering.renderedAs, "source");
    assert.equal(rendering.text, "a -> b");
    assert.deepEqual(
      rendering.saved.map((artifact) => artifact.path),
      ["docs/diagrams/flow.d2", "docs/diagrams/flow.svg"],
    );
    assert.ok(rendering.notes.some((note) => note.includes("No .txt was written")));
    assert.ok(rendering.notes.some((note) => note.includes("shown as source")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a text failure with nothing saved still fails the call", async () => {
  const renderer = createRenderer({
    extended: new TextRenderUnavailableError("beta renderer"),
    standard: new TextRenderUnavailableError("beta renderer"),
  });
  await assert.rejects(renderDiagram({ source: "a -> b" }, renderer), {
    name: "TextRenderUnavailableError",
  });
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
    assert.equal(rendering.renderedAs, "source");
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

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

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

test("a host that can show images gets one, with text kept as the fallback", async () => {
  const renderer = createRenderer();
  const rasterizer = createRasterizer();
  const rendering = await renderDiagram({ source: "a -> b", images: true }, renderer, rasterizer);

  assert.equal(rendering.image?.widthPx, 800);
  assert.equal(rendering.image?.heightPx, 600);
  assert.ok(rendering.image?.path.endsWith(".png"), rendering.image?.path);
  assert.equal(await readFile(rendering.image.path, "utf8"), PNG_BYTES.toString("utf8"));
  // The text is still drawn, because whether images display is only known later.
  assert.equal(rendering.renderedAs, "unicode");
  assert.equal(rendering.text, UNICODE_DIAGRAM);
  assert.equal(rasterizer.calls[0].svg, SVG);
});

test("asking for a text representation keeps the image out", async () => {
  for (const render of ["unicode", "ascii", "source"]) {
    const rasterizer = createRasterizer();
    const rendering = await renderDiagram(
      { source: "a -> b", render, images: true },
      createRenderer(),
      rasterizer,
    );
    assert.equal(rendering.image, undefined, render);
    assert.equal(rasterizer.calls.length, 0, render);
  }
});

test("an image that cannot be drawn leaves the diagram working, with a note", async () => {
  const rasterizer = createRasterizer({
    error: new ImageRenderUnavailableError("The rasterizer is missing."),
  });
  const rendering = await renderDiagram(
    { source: "a -> b", images: true },
    createRenderer(),
    rasterizer,
  );

  assert.equal(rendering.image, undefined);
  assert.equal(rendering.renderedAs, "unicode");
  assert.match(rendering.notes.join("\n"), /rasterizer is missing.*shown as text/s);
});

test("a failure that is not an image problem is not swallowed", async () => {
  await assert.rejects(
    renderDiagram(
      { source: "a -> b", images: true },
      createRenderer(),
      createRasterizer({ error: new TypeError("bug") }),
    ),
    { name: "TypeError" },
  );
});

test("labels the diagram's own font cannot draw are reported", async () => {
  const rendering = await renderDiagram(
    { source: "a -> b", images: true },
    createRenderer(),
    createRasterizer({ systemFonts: true }),
  );
  assert.match(rendering.notes.join("\n"), /fonts installed on this machine/);
});

test("a png reaches the repository only when it is asked for", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-render-"));
  try {
    const kept = await renderDiagram(
      {
        source: "a -> b",
        title: "Flow",
        images: true,
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
    // The image still exists for the terminal, outside the repository.
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
