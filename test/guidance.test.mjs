import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { registerDiagramGuidance, withGuidance } from "../dist/guidance.js";

const PI_PROMPT = "You are an expert coding assistant.";
const DIAGRAM_GUIDANCE = (
  await readFile(new URL("../src/guidance.md", import.meta.url), "utf8")
).trimEnd();

async function register() {
  const handlers = new Map();
  await registerDiagramGuidance({
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  return handlers;
}

test("the guidance is loaded before the host prompt hook", async () => {
  const handlers = await register();
  const handler = handlers.get("before_agent_start");
  assert.ok(handler);
  assert.equal(
    handler({ systemPrompt: PI_PROMPT }).systemPrompt,
    `${PI_PROMPT}\n\n${DIAGRAM_GUIDANCE}`,
  );
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

test("the guidance says when to draw and points to the tool selection rules", () => {
  assert.match(DIAGRAM_GUIDANCE, /^Diagrams:\n/);
  for (const view of ["C4", "sequence", "class", "data", "dependency", "tree"]) {
    assert.match(DIAGRAM_GUIDANCE, new RegExp(`\\b${view}\\b`), view);
  }
  assert.match(DIAGRAM_GUIDANCE, /tool description/u);
  assert.doesNotMatch(DIAGRAM_GUIDANCE, /\b(?:profile|shape) [a-z_]+/u);
  const bullets = DIAGRAM_GUIDANCE.split("\n").filter((line) => line.trim().startsWith("- "));
  assert.ok(bullets.length > 8);
});
