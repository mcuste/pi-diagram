import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSource, parseTitle } from "../dist/normalize.js";

test("line endings become LF and the byte-order mark is dropped", () => {
  const normalized = normalizeSource("﻿a -> b\r\nb -> c\r");
  assert.equal(normalized.text, "a -> b\nb -> c");
  assert.equal(normalized.lineCount, 2);
});

test("surrounding whitespace is trimmed", () => {
  assert.equal(normalizeSource("\n\n  a -> b  \n\n").text, "a -> b");
});

test("source that carries no diagram is refused", () => {
  for (const empty of ["", "   ", "\n\n"]) {
    assert.throws(() => normalizeSource(empty), { name: "DiagramSourceError" });
  }
});

test("source that is not a string is refused rather than coerced", () => {
  for (const value of [undefined, null, 42, {}, ["a -> b"]]) {
    assert.throws(() => normalizeSource(value), { name: "DiagramSourceError" });
  }
});

test("control characters are refused, but tabs and newlines are kept", () => {
  assert.throws(() => normalizeSource(`a -> b${String.fromCharCode(0)}`), {
    name: "DiagramSourceError",
    message: /U\+0000/,
  });
  assert.throws(() => normalizeSource(`a -> b${String.fromCharCode(27)}[31m`), {
    name: "DiagramSourceError",
    message: /U\+001B/,
  });
  assert.equal(normalizeSource("a: {\n\tshape: circle\n}").text, "a: {\n\tshape: circle\n}");
});

test("source above the size limit is refused with the limit named", () => {
  const huge = `${"a -> b\n".repeat(4000)}`;
  assert.throws(() => normalizeSource(huge), { message: /D2_TOO_LARGE/ });
});

test("the hash follows the normalized text, not the raw input", () => {
  const viaCrlf = normalizeSource("a -> b\r\n");
  const viaLf = normalizeSource("a -> b");
  assert.equal(viaCrlf.hash, viaLf.hash);
  assert.notEqual(viaLf.hash, normalizeSource("a -> c").hash);
  assert.match(viaLf.hash, /^[0-9a-f]{64}$/);
});

test("titles collapse to one line and stay bounded", () => {
  assert.equal(parseTitle("  Request   path\nlifecycle "), "Request path lifecycle");
  assert.equal(parseTitle("x".repeat(200)).length, 120);
  assert.equal(parseTitle(`Req${String.fromCharCode(7)}uest`), "Req uest");
});

test("a title with no text at all is treated as absent", () => {
  for (const value of [undefined, null, "", "   ", 7]) {
    assert.equal(parseTitle(value), undefined);
  }
});
