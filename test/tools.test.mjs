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

test("the tool asks for approval as a read until it writes artifacts", () => {
  assert.equal(diagram.approval({ source: "a -> b" }), "read");
  assert.equal(diagram.approval({ source: "a -> b", save: {} }), "write");
  assert.equal(diagram.approval(undefined), "read");
});

test("approval details name the directory a call would write to", () => {
  assert.equal(diagram.formatApprovalDetails({ source: "a -> b" }), undefined);
  assert.deepEqual(
    diagram.formatApprovalDetails({ source: "a -> b", save: { dir: "docs/arch" } }),
    ["Writes diagram artifacts to docs/arch."],
  );
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
      save: { dir: "docs/diagrams", basename: "request-lifecycle", formats: ["source", "svg"] },
    }),
  );
});

test("undocumented fields and values are rejected", () => {
  assert.ok(!accepts({ source: "a -> b", layout: "dagre" }));
  assert.ok(!accepts({ source: "a -> b", theme: 4 }));
  assert.ok(!accepts({ source: "a -> b", language: "graphviz" }));
  assert.ok(!accepts({ source: "a -> b", profile: "pretty" }));
  assert.ok(!accepts({ source: "a -> b", render: "svg" }));
  assert.ok(!accepts({ source: "a -> b", save: { formats: ["pdf"] } }));
  assert.ok(!accepts({ source: "a -> b", save: { sketch: true } }));
});

test("a saved diagram asks for at least one distinct format", () => {
  assert.ok(!accepts({ source: "a -> b", save: { formats: [] } }));
  assert.ok(!accepts({ source: "a -> b", save: { formats: ["svg", "svg"] } }));
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

test("a save request is refused instead of being silently dropped", async () => {
  const renderer = createRenderer();
  await assert.rejects(run(register(renderer), { source: "a -> b", save: { dir: "docs" } }), {
    name: "DiagramSourceError",
    message: /Saving diagram artifacts is not built yet.*without `save`/s,
  });
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
