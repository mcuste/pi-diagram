import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSafeSvg, SvgOutputError } from "../dist/svg.js";

const VALID_SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
const MULTILINE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">' +
  '<text x="10" y="10" text-anchor="middle"><tspan x="10" dy="0">line one</tspan>' +
  '<tspan x="10" dx="1" dy="18">line two</tspan></text></svg>';

test("a well formed SVG document is accepted and serialized with its SVG namespace", () => {
  assert.equal(parseSafeSvg(`  ${VALID_SVG}\n`), VALID_SVG);
  assert.equal(
    parseSafeSvg("<svg><g/></svg>"),
    '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>',
  );
  // D2 embeds fonts and injects CSS; both are expected and self-contained.
  const withAssets =
    '<svg><style>.a{}</style><path d="data:application/font-woff;base64,AA"/></svg>';
  assert.equal(
    parseSafeSvg(withAssets),
    '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{}</style><path d="data:application/font-woff;base64,AA"/></svg>',
  );
});

test("a multiline label drawn as tspan elements survives unchanged", () => {
  assert.equal(parseSafeSvg(MULTILINE_SVG), MULTILINE_SVG);
});

test("output that is not a complete SVG document is refused", () => {
  for (const bad of ["", "   ", "not svg at all", "<svg><g/>", '<?xml version="1.0"?>']) {
    assert.throws(() => parseSafeSvg(bad), SvgOutputError, bad);
  }
});

test("active or externally referenced SVG content is refused", () => {
  const hostile = [
    "<svg><script>alert(1)</script></svg>",
    "<svg><foreignObject><b>hi</b></foreignObject></svg>",
    '<svg><image href="/etc/hosts"/></svg>',
    '<svg><a xlink:href="https://example.com">x</a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><constructor/></svg>',
    '<svg><use href="//example.com/x"/></svg>',
    '<svg onload="alert(1)"></svg>',
    '<svg><text onclick="x">a</text></svg>',
    '<svg><a href="javascript:alert(1)">x</a></svg>',
    "<svg><style>@import url(https://example.com/x.css)</style></svg>",
    '<svg><style>.x { fill: url("https://example.com/x") }</style></svg>',
  ];
  for (const svg of hostile) {
    assert.throws(() => parseSafeSvg(svg), SvgOutputError, svg);
  }
});
