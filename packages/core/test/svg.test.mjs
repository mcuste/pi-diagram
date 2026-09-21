import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSafeSvg, SvgOutputError } from "../dist/svg.js";

const MULTILINE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">' +
  '<text x="10" y="10"><tspan x="10" dy="0">line one</tspan>' +
  '<tspan x="10" dy="18">line two</tspan></text></svg>';

test("multiline D2 labels using tspan are accepted", () => {
  const out = parseSafeSvg(MULTILINE_SVG);
  assert.match(out, /<tspan/);
});

test("tspan positioning attributes are accepted", () => {
  const out = parseSafeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<text text-anchor="middle"><tspan x="5" y="6" dx="1" dy="2">a</tspan></text></svg>',
  );
  assert.match(out, /<tspan/);
});

test("active content is still rejected", () => {
  assert.throws(
    () => parseSafeSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    SvgOutputError,
  );
  assert.throws(
    () => parseSafeSvg('<svg xmlns="http://www.w3.org/2000/svg"><text onclick="x">a</text></svg>'),
    SvgOutputError,
  );
});
