import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TextRenderUnavailableError } from "../dist/d2/runner.js";
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
    renderSvg({ source, signal }) {
      calls.push({ kind: "svg", source, signal });
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

test("an image request is answered with text, because that is a display fallback", async () => {
  const renderer = createRenderer();
  const rendering = await renderDiagram({ source: "a -> b", render: "image" }, renderer);
  assert.equal(rendering.renderedAs, "unicode");
  assert.equal(textCalls(renderer)[0].asciiMode, "extended");
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
