import assert from "node:assert/strict";
import { test } from "node:test";
import { DIAGRAM_GUIDANCE, registerDiagramGuidance, withGuidance } from "../dist/guidance.js";
import piDiagram from "../dist/index.js";

const PI_PROMPT = "You are an expert coding assistant.";

function register() {
  const handlers = new Map();
  registerDiagramGuidance({
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  return handlers;
}

test("the guidance is registered on the host prompt hook", () => {
  const handlers = register();
  assert.deepEqual([...handlers.keys()], ["before_agent_start"]);
});

test("a host without a prompt hook still loads", async () => {
  const registered = [];
  const flags = new Map();
  await piDiagram({
    registerTool(definition) {
      registered.push(definition.name);
    },
    registerFlag(name, options) {
      flags.set(name, options.default);
    },
    getFlag(name) {
      return flags.get(name);
    },
  });
  assert.deepEqual(registered, ["diagram"]);
});

test("Pi gets the guidance after its prompt", () => {
  const result = withGuidance({ systemPrompt: PI_PROMPT });
  assert.equal(result.systemPrompt, `${PI_PROMPT}\n\n${DIAGRAM_GUIDANCE}`);
});

test("Oh My Pi gets the guidance as one more block", () => {
  const result = withGuidance({ systemPrompt: ["base", "tools"] });
  assert.deepEqual(result.systemPrompt, ["base", "tools", DIAGRAM_GUIDANCE]);
});

test("a prompt that already carries the guidance is left alone", () => {
  assert.equal(withGuidance({ systemPrompt: `${PI_PROMPT}\n\n${DIAGRAM_GUIDANCE}` }), undefined);
  assert.equal(withGuidance({ systemPrompt: ["base", DIAGRAM_GUIDANCE] }), undefined);
});

test("a prompt that cannot be read is left alone, because the hook replaces it", () => {
  assert.equal(withGuidance({}), undefined);
  assert.equal(withGuidance({ systemPrompt: "" }), undefined);
  assert.equal(withGuidance({ systemPrompt: [] }), undefined);
});

test("nothing is added when the diagram tool is not active", () => {
  const options = { selectedTools: ["read", "bash"] };
  assert.equal(withGuidance({ systemPrompt: PI_PROMPT, systemPromptOptions: options }), undefined);
  const active = { selectedTools: ["read", "diagram"] };
  assert.ok(withGuidance({ systemPrompt: PI_PROMPT, systemPromptOptions: active }));
});

test("the guidance says when to draw and which diagram fits", () => {
  assert.match(DIAGRAM_GUIDANCE, /^Diagrams:\n/);
  // Every profile has to be reachable from the guidance, or a profile is never chosen.
  for (const profile of ["explain", "architecture", "data", "docs", "tree", "c4", "dependency"]) {
    assert.match(DIAGRAM_GUIDANCE, new RegExp(`profile ${profile}\\b`), profile);
  }
  const bullets = DIAGRAM_GUIDANCE.split("\n").filter((line) => line.trim().startsWith("- "));
  assert.ok(bullets.length > 8);
});
