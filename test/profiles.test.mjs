import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PROFILE, PROFILE_NAMES, parseProfile } from "../dist/d2/profiles.js";
import { registerDiagramTools } from "../dist/tools.js";

test("a diagram with no purpose named is drawn by hand, for a conversation", () => {
  assert.equal(parseProfile(undefined).name, "explain");
  assert.equal(DEFAULT_PROFILE.name, "explain");
  assert.equal(DEFAULT_PROFILE.sketch, true);
});

test("only a conversational diagram is drawn by hand", () => {
  const sketched = PROFILE_NAMES.filter((name) => parseProfile(name).sketch);
  assert.deepEqual(sketched, ["explain"]);
});

test("every profile the schema offers has a policy behind it", () => {
  const tools = new Map();
  registerDiagramTools({ registerTool: (definition) => tools.set(definition.name, definition) });
  const offered = tools
    .get("diagram")
    .parameters.properties.profile.anyOf.map((member) => member.const);

  assert.deepEqual(offered, [...PROFILE_NAMES]);
  for (const name of offered) {
    assert.equal(parseProfile(name).name, name);
  }
});

test("no two profiles are the same policy under two names", () => {
  const policies = PROFILE_NAMES.map((name) => {
    const { name: _, ...policy } = parseProfile(name);
    return JSON.stringify(policy);
  });
  assert.equal(new Set(policies).size, policies.length);
});

test("ELK stays the engine for everything except a hierarchy", () => {
  const byEngine = new Map();
  for (const name of PROFILE_NAMES) {
    const { engine } = parseProfile(name).layout;
    byEngine.set(engine, [...(byEngine.get(engine) ?? []), name]);
  }
  assert.deepEqual(byEngine.get("dagre"), ["tree"]);
  assert.equal(byEngine.get("elk").length, PROFILE_NAMES.length - 1);
});

test("every profile stays inside what D2 accepts", () => {
  for (const name of PROFILE_NAMES) {
    const { name: _, sketch, layout, theme, darkTheme, ...pixels } = parseProfile(name);
    assert.equal(typeof sketch, "boolean", name);
    // Theme 0 is D2's default theme, so an id of zero is meaningful where a gap of zero is not.
    for (const [field, id] of Object.entries({ theme, darkTheme })) {
      assert.ok(Number.isSafeInteger(id) && id >= 0, `${name}.${field} is ${id}`);
    }
    for (const [field, value] of Object.entries({ ...pixels, ...layout })) {
      if (field === "engine") {
        continue;
      }
      assert.ok(Number.isSafeInteger(value) && value > 0, `${name}.${field} is ${value}`);
    }
  }
});

test("a profile outside the table is refused rather than guessed at", () => {
  for (const raw of ["pretty", "Explain", "", null, 3, {}]) {
    assert.throws(() => parseProfile(raw), { name: "DiagramSourceError" }, `${raw}`);
  }
  assert.throws(() => parseProfile("toString"), { name: "DiagramSourceError" });
});
