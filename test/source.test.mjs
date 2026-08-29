import assert from "node:assert/strict";
import { test } from "node:test";
import { parseD2Source, parseTitle } from "../dist/d2/source.js";

test("line endings become LF and the byte-order mark is dropped", () => {
  const parsed = parseD2Source("﻿a -> b\r\nb -> c\r");
  assert.equal(parsed.source, "a -> b\nb -> c");
  assert.equal(parsed.lineCount, 2);
});

test("surrounding whitespace is trimmed", () => {
  assert.equal(parseD2Source("\n\n  a -> b  \n\n").source, "a -> b");
});

test("source that carries no diagram is refused", () => {
  for (const empty of ["", "   ", "\n\n"]) {
    assert.throws(() => parseD2Source(empty), { name: "DiagramSourceError" });
  }
});

test("source that is not a string is refused rather than coerced", () => {
  for (const value of [undefined, null, 42, {}, ["a -> b"]]) {
    assert.throws(() => parseD2Source(value), { name: "DiagramSourceError" });
  }
});

test("control characters are refused, but tabs and newlines are kept", () => {
  assert.throws(() => parseD2Source(`a -> b${String.fromCharCode(0)}`), {
    name: "DiagramSourceError",
    message: /U\+0000/,
  });
  assert.throws(() => parseD2Source(`a -> b${String.fromCharCode(27)}[31m`), {
    name: "DiagramSourceError",
    message: /U\+001B/,
  });
  assert.throws(() => parseD2Source(`a -> b${String.fromCharCode(0x9b)}31m`), {
    name: "DiagramSourceError",
    message: /U\+009B/,
  });
  assert.equal(parseD2Source("a: {\n\tshape: circle\n}").source, "a: {\n\tshape: circle\n}");
});

test("source above the size limit is refused with the limit named", () => {
  const huge = `${"a -> b\n".repeat(4000)}`;
  assert.throws(() => parseD2Source(huge), { message: /D2_TOO_LARGE/ });
});

test("the hash follows the normalized text, not the raw input", () => {
  const viaCrlf = parseD2Source("a -> b\r\n");
  const viaLf = parseD2Source("a -> b");
  assert.equal(viaCrlf.hash, viaLf.hash);
  assert.notEqual(viaLf.hash, parseD2Source("a -> c").hash);
  assert.match(viaLf.hash, /^[0-9a-f]{64}$/);
});

test("titles collapse to one line and respect the schema limit", () => {
  assert.equal(parseTitle("  Request   path\nlifecycle "), "Request path lifecycle");
  assert.throws(() => parseTitle("x".repeat(121)), { name: "DiagramSourceError" });
  assert.equal(parseTitle(`Req${String.fromCharCode(7)}uest`), "Req uest");
});

test("only an omitted title is absent", () => {
  assert.equal(parseTitle(undefined), undefined);
  for (const value of [null, "", "   ", 7]) {
    assert.throws(() => parseTitle(value), { name: "DiagramSourceError" }, String(value));
  }
});
