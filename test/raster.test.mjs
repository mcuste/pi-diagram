import assert from "node:assert/strict";
import { test } from "node:test";
import { missingCodePoints, parseEmbeddedFonts, textCodePoints } from "../dist/d2/fonts.js";
import { ImageRenderUnavailableError, parseRenderedPng, parseTargetWidth } from "../dist/raster.js";
import { face } from "./fixtures/font.mjs";

/** A PNG header the checks accept, with the sizes and trailer they look at. */
function png({ width = 800, height = 600, trailer = "IEND", signature = true } = {}) {
  const header = Buffer.alloc(24);
  const magic = signature
    ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    : Buffer.alloc(8);
  magic.copy(header, 0);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  const end = Buffer.alloc(8);
  end.write(trailer, 0, "ascii");
  return Buffer.concat([header, end]);
}

function svgWith(faces, text = "api") {
  const blocks = faces
    .map(
      ({ family, woff }) =>
        `@font-face { font-family: ${family}; src: url("data:application/font-woff;base64,${woff.toString("base64")}"); }`,
    )
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg"><style>${blocks}</style><text x="0" y="0"><tspan>${text}</tspan></text></svg>`;
}

test("a PNG is accepted only when it really is one of the size that was asked for", () => {
  assert.equal(parseRenderedPng(png({ width: 800 }), 800).widthPx, 800);
  assert.equal(parseRenderedPng(png({ width: 801 }), 800).heightPx, 600);

  for (const [bytes, expected] of [
    [png({ signature: false }), /did not return a PNG/],
    [png({ trailer: "IDAT" }), /truncated/],
    [png({ width: 0 }), /no area/],
    [png({ width: 900 }), /not the 800/],
    [Buffer.alloc(10), /did not return a PNG/],
  ]) {
    assert.throws(
      () => parseRenderedPng(bytes, 800),
      ImageRenderUnavailableError,
      String(expected),
    );
  }
});

test("an image header claiming something other than IHDR is refused", () => {
  const bytes = png();
  bytes.write("IDAT", 12, "ascii");
  assert.throws(() => parseRenderedPng(bytes, 800), /image header/);
});

test("the draw width is twice the diagram, inside fixed bounds", () => {
  assert.equal(parseTargetWidth(400, 300), 800);
  // Wide diagrams stop at the width limit, tall ones at the height limit.
  assert.equal(parseTargetWidth(2000, 100), 1600);
  assert.equal(parseTargetWidth(400, 4800), 200);
  // A tiny diagram is still drawn big enough to read.
  assert.equal(parseTargetWidth(100, 80), 480);
});

test("a canvas with no area is refused rather than drawn", () => {
  for (const [width, height] of [
    [0, 100],
    [100, 0],
    [Number.NaN, 100],
    [Number.POSITIVE_INFINITY, 100],
  ]) {
    assert.throws(() => parseTargetWidth(width, height), ImageRenderUnavailableError);
  }
});

test("the fonts the SVG carries come back as usable font files", () => {
  const fonts = parseEmbeddedFonts(svgWith([{ family: "d2-1-font-regular", woff: face("api") }]));
  assert.equal(fonts.length, 1);
  assert.equal(fonts[0].family, "d2-1-font-regular");
  // Rebuilt as sfnt, which is what a font rasterizer reads.
  assert.deepEqual([...fonts[0].bytes.subarray(0, 4)], [0x00, 0x01, 0x00, 0x00]);
  assert.deepEqual(
    [...fonts[0].coverage].sort(),
    ["a", "p", "i"].map((c) => c.codePointAt(0)).sort(),
  );
});

test("a face that cannot be rebuilt is left out rather than guessed at", () => {
  const damaged = face("api");
  damaged.writeUInt16BE(999, 12);
  assert.deepEqual(parseEmbeddedFonts(svgWith([{ family: "broken", woff: damaged }])), []);
});

test("characters no embedded face can draw are reported", () => {
  const svg = svgWith([{ family: "d2-1-font-regular", woff: face("api") }], "api 注文");
  const fonts = parseEmbeddedFonts(svg);
  const missing = missingCodePoints(fonts, textCodePoints(svg));
  assert.deepEqual(
    missing.map((code) => String.fromCodePoint(code)),
    ["注", "文"],
  );
});

test("a fully covered diagram reports nothing missing", () => {
  const svg = svgWith([{ family: "d2-1-font-regular", woff: face("api") }], "api");
  assert.deepEqual(missingCodePoints(parseEmbeddedFonts(svg), textCodePoints(svg)), []);
});

test("text is read from the elements that draw it, with entities decoded", () => {
  const svg = svgWith([], "a &amp; b &#65;");
  assert.deepEqual([...textCodePoints(svg)].map((code) => String.fromCodePoint(code)).sort(), [
    "&",
    "A",
    "a",
    "b",
  ]);
});

test("with no faces at all every character counts as missing", () => {
  const svg = svgWith([], "ab");
  assert.deepEqual(missingCodePoints([], textCodePoints(svg)).length, 2);
});

test("a compressed face is decompressed, the way D2 embeds one", () => {
  const svg = svgWith([{ family: "d2-1-font-bold", woff: face("abc", { compress: true }) }], "abc");
  assert.deepEqual(missingCodePoints(parseEmbeddedFonts(svg), textCodePoints(svg)), []);
});

test("a face declaring more tables than it holds is left out", () => {
  const lying = face("abc");
  lying.writeUInt32BE(0xffff_ffff, 44 + 8);
  assert.deepEqual(parseEmbeddedFonts(svgWith([{ family: "lying", woff: lying }])), []);
});

test("something that is not a font is left out", () => {
  const svg = `<svg><style>@font-face { font-family: fake; src: url("data:application/font-woff;base64,${Buffer.from(
    "not a font at all, just some bytes pretending to be one",
  ).toString("base64")}"); }</style><text>a</text></svg>`;
  assert.deepEqual(parseEmbeddedFonts(svg), []);
});
