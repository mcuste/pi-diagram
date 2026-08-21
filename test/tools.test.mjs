import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { DiagramRendererUnavailableError, registerDiagramTools } from "../dist/tools.js";

function registerTools() {
  const tools = new Map();
  registerDiagramTools({
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
  });
  return tools;
}

const diagram = registerTools().get("diagram");
const parameters = diagram.parameters;

function accepts(args) {
  return Value.Check(parameters, args);
}

test("the tool asks for approval as a read until it writes artifacts", () => {
  assert.equal(diagram.approval({ source: "a -> b" }), "read");
  assert.equal(diagram.approval({ source: "a -> b", save: {} }), "write");
});

test("approval details name the directory a call would write to", () => {
  assert.equal(diagram.formatApprovalDetails({ source: "a -> b" }), undefined);
  assert.deepEqual(
    diagram.formatApprovalDetails({ source: "a -> b", save: { dir: "docs/arch" } }),
    ["Writes diagram artifacts to docs/arch."],
  );
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

test("a call reports that rendering is unimplemented instead of drawing something else", async () => {
  await assert.rejects(
    diagram.execute("call-1", { source: "a -> b" }, undefined, () => {}, { cwd: process.cwd() }),
    DiagramRendererUnavailableError,
  );
});
