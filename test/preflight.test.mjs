import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect, parseSafeSource } from "../dist/d2/preflight.js";
import { normalizeSource } from "../dist/normalize.js";

function diagnose(source) {
  return inspect(normalizeSource(source).text);
}

function codes(source) {
  return diagnose(source).map((diagnostic) => diagnostic.code);
}

test("imports are refused wherever they appear", () => {
  assert.deepEqual(codes("a -> b\n...@secret/private"), ["D2_IMPORT"]);
  assert.deepEqual(codes("a: @other"), ["D2_IMPORT"]);
  assert.deepEqual(codes("@/etc/hosts\na -> b"), ["D2_IMPORT"]);
  assert.deepEqual(codes("a: {\n  ...@base\n}"), ["D2_IMPORT"]);
});

test("an at-sign inside a word is label text, not an import", () => {
  assert.deepEqual(codes("a: user@example.com"), []);
  assert.deepEqual(codes('a: "user@example.com"'), []);
  assert.deepEqual(codes("owner -> service: mail@corp.test"), []);
});

test("asset and navigation keys are refused", () => {
  assert.deepEqual(codes("s: server {\n  icon: https://example.com/x.svg\n}"), ["D2_ICON"]);
  assert.deepEqual(codes("s.icon: /etc/hosts"), ["D2_ICON"]);
  assert.deepEqual(codes("s: server {\n  link: https://example.com\n}"), ["D2_LINK"]);
});

test("the image shape is refused separately from an unknown shape", () => {
  assert.deepEqual(codes("p: {\n  shape: image\n}"), ["D2_IMAGE_SHAPE"]);
  assert.deepEqual(codes("p: {\n  shape: teapot\n}"), ["D2_UNKNOWN_SHAPE"]);
  assert.deepEqual(codes('p: {\n  shape: "image"\n}'), ["D2_UNKNOWN_SHAPE"]);
});

test("every shape the tool supports is accepted", () => {
  const shapes = [
    "rectangle",
    "square",
    "page",
    "parallelogram",
    "document",
    "cylinder",
    "queue",
    "package",
    "step",
    "callout",
    "stored_data",
    "person",
    "diamond",
    "oval",
    "circle",
    "hexagon",
    "cloud",
    "text",
    "code",
    "class",
    "sql_table",
    "sequence_diagram",
    "c4-person",
  ];
  for (const shape of shapes) {
    assert.deepEqual(codes(`n: {\n  shape: ${shape}\n}`), [], shape);
  }
});

test("block strings are refused, including the code and LaTeX forms", () => {
  assert.deepEqual(codes("a: |md\n  # heading\n|\na -> b"), ["D2_BLOCK_STRING"]);
  assert.deepEqual(codes("a: |`ts\n  const x = 1\n`|"), ["D2_BLOCK_STRING"]);
  assert.deepEqual(codes("a: |latex\n  x^2\n|"), ["D2_BLOCK_STRING"]);
});

test("a pipe inside a quoted label is not a block string", () => {
  assert.deepEqual(codes('a -> b: "left | right"'), []);
  assert.deepEqual(codes("a -> b: 'left | right'"), []);
});

test("renderer configuration cannot come from the source", () => {
  assert.deepEqual(codes("vars: {\n  d2-config: {\n    theme-id: 4\n  }\n}\na -> b"), [
    "D2_CONFIG",
  ]);
  assert.deepEqual(codes("vars: {\n  d2-config: {\n    layout-engine: tala\n  }\n}"), [
    "D2_CONFIG",
    "D2_CONFIG",
  ]);
});

test("comments and quoted strings hide what would otherwise be refused", () => {
  assert.deepEqual(codes("# icon: https://example.com/x.svg\na -> b"), []);
  assert.deepEqual(codes('a: "# not a comment"'), []);
  assert.deepEqual(codes('a: "shape: image"'), []);
  assert.deepEqual(codes("a -> b # ...@secret"), []);
});

test("keys that merely start with a refused name are left alone", () => {
  assert.deepEqual(codes("icons -> store"), []);
  assert.deepEqual(codes("linkage -> b"), []);
  assert.deepEqual(codes("shapes: {\n  a\n}"), []);
});

test("an unterminated string is refused instead of being guessed at", () => {
  assert.deepEqual(codes('a: "oops\nb -> c'), ["D2_UNTERMINATED"]);
  assert.deepEqual(codes("a: 'oops"), ["D2_UNTERMINATED"]);
});

test("a refusal stops the scan, because code and content can no longer be told apart", () => {
  // The icon on the last line is never reached: the block string already made parsing unsound.
  assert.deepEqual(codes("a: |md\n  hi\n|\ns: { icon: /etc/hosts }"), ["D2_BLOCK_STRING"]);
});

test("diagnostics carry the line and column of the problem", () => {
  const [diagnostic] = diagnose("a -> b\nc -> d\ns: {\n  icon: /etc/hosts\n}");
  assert.equal(diagnostic.code, "D2_ICON");
  assert.equal(diagnostic.line, 4);
  assert.equal(diagnostic.column, 3);
  assert.ok(diagnostic.hint);
});

test("several problems are reported in source order", () => {
  const found = diagnose("s: {\n  link: https://example.com\n}\np: {\n  shape: image\n}");
  assert.deepEqual(
    found.map((diagnostic) => [diagnostic.code, diagnostic.line]),
    [
      ["D2_LINK", 2],
      ["D2_IMAGE_SHAPE", 5],
    ],
  );
});

test("parseSafeSource returns the source it accepts and throws on the rest", () => {
  const normalized = normalizeSource("a -> b");
  assert.equal(parseSafeSource(normalized.text), "a -> b");
  assert.throws(() => parseSafeSource(normalizeSource("...@secret").text), {
    name: "DiagramSourceError",
    message: /D2_IMPORT/,
  });
});
