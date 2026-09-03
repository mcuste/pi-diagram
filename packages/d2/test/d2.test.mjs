import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CommandInvocationError,
  CommandOutputLimitError,
  CommandTimeoutError,
  FileCache,
  noCache,
} from "@mcuste/pi-diagram-core";
import { parseD2Diagnostics } from "../dist/diagnostics.js";
import { DEFAULT_PROFILE, PROFILE_NAMES, parseProfile } from "../dist/profiles.js";
import {
  D2Cli,
  parseBinaryName,
  parseD2Version,
  parseRenderedSvg,
  parseRenderedText,
} from "../dist/runner.js";

const UNICODE_DIAGRAM = "┌────┐\n│ a  │\n└────┘";
const ASCII_DIAGRAM = "+----+\n| a  |\n+----+";

function version(stdout, exitCode = 0) {
  return { command: "d2", args: ["--version"], exitCode, stdout, stderr: "" };
}

/**
 * A stand-in for the CLI that records every call. `render` decides what the render step returns,
 * so a test can make one stage fail without touching the others.
 */
function createRunner({ installed = "v0.8.1-HEAD", validate = {}, render = {} } = {}) {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args: [...args], options, cwd: options.cwd });
    if (args[0] === "--version") {
      if (installed instanceof Error) {
        throw installed;
      }
      return version(installed);
    }
    if (args[0] === "validate") {
      if (validate.error) {
        throw validate.error;
      }
      return {
        command,
        args,
        exitCode: validate.exitCode ?? 0,
        stdout: "",
        stderr: validate.stderr ?? "",
      };
    }
    if (render.error) {
      throw render.error;
    }
    return {
      command,
      args,
      exitCode: render.exitCode ?? 0,
      stdout: render.stdout ?? UNICODE_DIAGRAM,
      stderr: render.stderr ?? "success: compiled\n",
    };
  };
  return { runner, calls };
}

function cli(options) {
  const { runner, calls } = createRunner(options);
  // No cache: these tests are about what reaches the D2 process.
  return { d2: new D2Cli({ runner, binary: "d2", cache: noCache }), calls };
}

function request(source = "a -> b", asciiMode = "extended") {
  return { source, asciiMode, signal: undefined };
}

test("a supported version is accepted and the build suffix ignored", () => {
  assert.equal(parseD2Version(version("v0.8.1-HEAD")), "v0.8.1-HEAD");
  assert.equal(parseD2Version(version("0.8.0")), "0.8.0");
  assert.equal(parseD2Version(version("v1.2.3")), "v1.2.3");
  assert.equal(parseD2Version(version("v0.9.0")), "v0.9.0");
});

test("an older or unreadable version reports how to install a supported one", () => {
  for (const raw of ["v0.7.1", "0.6.9"]) {
    assert.throws(() => parseD2Version(version(raw)), {
      name: "D2UnavailableError",
      message: /too old.*go install github\.com\/d2lang\/d2/s,
    });
  }
  for (const raw of ["", "not a version", "v1.2", "v0.8.1\u001b[31m", "v0.8.1\u009b31m"]) {
    assert.throws(() => parseD2Version(version(raw)), { name: "D2UnavailableError" });
  }
  assert.throws(() => parseD2Version(version("v0.8.1", 1)), { name: "D2UnavailableError" });
});

test("rendered text has to match the mode that was asked for", () => {
  assert.equal(parseRenderedText(UNICODE_DIAGRAM, "extended"), UNICODE_DIAGRAM);
  assert.equal(parseRenderedText(ASCII_DIAGRAM, "standard"), ASCII_DIAGRAM);
  assert.throws(() => parseRenderedText(UNICODE_DIAGRAM, "standard"), {
    name: "TextRenderUnavailableError",
    message: /non-ASCII/,
  });
});

test("output that cannot be a diagram is refused", () => {
  for (const empty of ["", "   ", "\n\n"]) {
    assert.throws(() => parseRenderedText(empty, "extended"), {
      name: "TextRenderUnavailableError",
      message: /empty/,
    });
  }
  assert.throws(() => parseRenderedText("plain words only", "extended"), {
    name: "TextRenderUnavailableError",
    message: /no diagram lines or boxes/,
  });
  assert.throws(
    () => parseRenderedText(`${UNICODE_DIAGRAM}${String.fromCharCode(27)}[31m`, "extended"),
    {
      name: "TextRenderUnavailableError",
      message: /control character/,
    },
  );
  assert.throws(() => parseRenderedText(`${UNICODE_DIAGRAM}\u009b31m`, "extended"), {
    name: "TextRenderUnavailableError",
    message: /control character/,
  });
});

test("D2 diagnostics drop terminal control characters", () => {
  const [diagnostic] = parseD2Diagnostics("input.d2:1:2: bad\u001b[31m\u009b31m", "D2_RENDER", []);
  assert.equal(diagnostic.message, "bad[31m31m");
});

test("trailing blank space is removed so the transcript has no ragged edge", () => {
  assert.equal(parseRenderedText("+--+   \n|  |\t\n+--+\n\n\n", "standard"), "+--+\n|  |\n+--+");
});

test("D2_BIN is refused when it could turn into an option or extra arguments", () => {
  assert.equal(parseBinaryName(undefined), "d2");
  assert.equal(parseBinaryName("   "), "d2");
  assert.equal(parseBinaryName("/opt/homebrew/bin/d2"), "/opt/homebrew/bin/d2");
  for (const hostile of [
    "--layout",
    "-v",
    "d2; rm -rf /",
    "d2 && echo",
    "d2 | tee",
    "$(which d2)",
  ]) {
    assert.throws(() => parseBinaryName(hostile), { name: "D2UnavailableError" }, hostile);
  }
});

test("the source reaches D2 as a file, never as an argument", async () => {
  const { d2, calls } = cli();
  const source = "secret -> value: do not put me in argv";
  await d2.renderText(request(source));

  const render = calls.at(-1);
  assert.deepEqual(render.args, [
    "--layout",
    "elk",
    "--timeout",
    "10",
    "--ascii-mode",
    "extended",
    "--stdout-format",
    "ascii",
    "input.d2",
    "-",
  ]);
  for (const call of calls) {
    for (const argument of call.args) {
      assert.ok(!argument.includes("secret"), `argv leaked source: ${argument}`);
    }
  }
});

test("D2 runs in a private directory holding only the source, then it is removed", async () => {
  let seen;
  const { runner } = createRunner();
  const d2 = new D2Cli({
    cache: noCache,
    binary: "d2",
    runner: async (command, args, options) => {
      if (args[0] === "validate") {
        seen = { cwd: options.cwd, input: readFileSync(join(options.cwd, "input.d2"), "utf8") };
      }
      return runner(command, args, options);
    },
  });

  await d2.renderText(request("a -> b"));
  assert.equal(seen.input, "a -> b\n");
  assert.match(seen.cwd, /pi-diagram-/);
  assert.equal(existsSync(seen.cwd), false, "the render directory outlived the call");
});

test("only PATH is handed to the subprocess, with a time and output limit", async () => {
  const { d2, calls } = cli();
  await d2.renderText(request());
  for (const call of calls) {
    assert.deepEqual(Object.keys(call.options.env), ["PATH"]);
    assert.equal(call.options.timeoutMs, 15_000);
    assert.ok(call.options.maxOutputBytes > 0);
  }
});

test("the version is read once and reused", async () => {
  const { d2, calls } = cli();
  await d2.renderText(request());
  await d2.renderText(request());
  assert.equal(calls.filter((call) => call.args[0] === "--version").length, 1);
});

test("a version check that failed is retried, so installing D2 mid-session works", async () => {
  let installed = new CommandInvocationError("d2", "not found", "ENOENT");
  const d2 = new D2Cli({
    cache: noCache,
    binary: "d2",
    runner: async (command, args) => {
      if (args[0] === "--version") {
        if (installed instanceof Error) {
          throw installed;
        }
        return version(installed);
      }
      if (args[0] === "validate") {
        return { command, args, exitCode: 0, stdout: "", stderr: "" };
      }
      return { command, args, exitCode: 0, stdout: UNICODE_DIAGRAM, stderr: "" };
    },
  });

  await assert.rejects(d2.renderText(request()), { name: "D2UnavailableError" });
  installed = "v0.8.1-HEAD";
  const rendered = await d2.renderText(request());
  assert.equal(rendered.text, UNICODE_DIAGRAM);
});

test("a source D2 will not compile is reported with its line and column", async () => {
  const { d2 } = cli({
    validate: {
      exitCode: 1,
      stderr: "err: github.com/d2lang/d2/d2cli.validateCmd: 2:6: bad thing\n",
    },
  });
  await assert.rejects(d2.renderText(request()), (error) => {
    assert.equal(error.name, "DiagramSourceError");
    assert.deepEqual(error.diagnostics, [
      { code: "D2_SYNTAX", message: "bad thing", line: 2, column: 6 },
    ]);
    return true;
  });
});

test("a render that fails after the source compiled is a text-renderer problem", async () => {
  const { d2 } = cli({ render: { exitCode: 1, stderr: "err: ascii render unsupported\n" } });
  await assert.rejects(d2.renderText(request()), { name: "TextRenderUnavailableError" });
});

test("the temporary path in a render error never reaches the caller", async () => {
  let directory;
  const { runner } = createRunner();
  const d2 = new D2Cli({
    cache: noCache,
    binary: "d2",
    runner: async (command, args, options) => {
      if (args[0] !== "validate" && args[0] !== "--version") {
        directory = options.cwd;
        return {
          command,
          args,
          exitCode: 1,
          stdout: "",
          stderr: `err: failed to compile input.d2: ${options.cwd}/input.d2:3:1: broken\n`,
        };
      }
      return runner(command, args, options);
    },
  });

  await assert.rejects(d2.renderText(request()), (error) => {
    assert.ok(directory);
    assert.ok(!error.message.includes(directory), error.message);
    assert.deepEqual(error.diagnostics, [
      { code: "D2_RENDER", message: "broken", line: 3, column: 1 },
    ]);
    return true;
  });
});

test("a missing D2 install is reported as something the user has to fix", async () => {
  const { d2 } = cli({ installed: new CommandInvocationError("d2", "spawn d2 ENOENT", "ENOENT") });
  await assert.rejects(d2.renderText(request()), {
    name: "D2UnavailableError",
    message: /Could not run "d2".*brew install d2/s,
  });
});

test("a timeout or an output flood becomes advice to shrink the diagram", async () => {
  const timedOut = cli({ render: { error: new CommandTimeoutError("d2", 15_000) } });
  await assert.rejects(timedOut.d2.renderText(request()), {
    name: "DiagramSourceError",
    message: /D2_TIMEOUT/,
  });

  const flooded = cli({ render: { error: new CommandOutputLimitError("d2", 512 * 1024) } });
  await assert.rejects(flooded.d2.renderText(request()), {
    name: "DiagramSourceError",
    message: /D2_TOO_LARGE/,
  });
});

test("standard mode asks D2 for standard mode", async () => {
  const { d2, calls } = cli({ render: { stdout: ASCII_DIAGRAM } });
  await d2.renderText(request("a -> b", "standard"));
  assert.ok(calls.at(-1).args.includes("standard"));
});

const VALID_SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';

test("a well formed SVG document is accepted and serialized with its SVG namespace", () => {
  assert.equal(parseRenderedSvg(`  ${VALID_SVG}\n`), VALID_SVG);
  assert.equal(
    parseRenderedSvg("<svg><g/></svg>"),
    '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>',
  );
  // D2 embeds fonts and injects CSS; both are expected and self-contained.
  const withAssets =
    '<svg><style>.a{}</style><path d="data:application/font-woff;base64,AA"/></svg>';
  assert.equal(
    parseRenderedSvg(withAssets),
    '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{}</style><path d="data:application/font-woff;base64,AA"/></svg>',
  );
});

test("output that is not a complete SVG document is refused", () => {
  for (const bad of ["", "   ", "not svg at all", "<svg><g/>", '<?xml version="1.0"?>']) {
    assert.throws(() => parseRenderedSvg(bad), { name: "SvgRenderUnavailableError" }, bad);
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
    '<svg><a href="javascript:alert(1)">x</a></svg>',
    "<svg><style>@import url(https://example.com/x.css)</style></svg>",
    '<svg><style>.x { fill: url("https://example.com/x") }</style></svg>',
  ];
  for (const svg of hostile) {
    assert.throws(() => parseRenderedSvg(svg), { name: "SvgRenderUnavailableError" }, svg);
  }
});

test("an SVG render carries the profile's whole policy, and nothing the source can set", async () => {
  const { d2, calls } = cli({ render: { stdout: VALID_SVG } });
  const rendered = await d2.renderSvg({
    source: "a -> b",
    profile: DEFAULT_PROFILE,
    signal: undefined,
  });
  assert.equal(rendered.svg, VALID_SVG);
  assert.deepEqual(calls.at(-1).args, [
    "--layout",
    "elk",
    "--elk-nodeNodeBetweenLayers",
    "60",
    "--elk-edgeNodeBetweenLayers",
    "40",
    "--elk-padding",
    "[top=40,left=40,bottom=40,right=40]",
    "--sketch",
    "--theme",
    "0",
    "--dark-theme",
    "200",
    "--pad",
    "30",
    "--timeout",
    "10",
    "--stdout-format",
    "svg",
    "input.d2",
    "-",
  ]);
});

test("a hierarchy is drawn by the other engine, with that engine's own options", async () => {
  const { d2, calls } = cli({ render: { stdout: VALID_SVG } });
  await d2.renderSvg({ source: "a -> b", profile: parseProfile("tree"), signal: undefined });
  assert.deepEqual(calls.at(-1).args, [
    "--layout",
    "dagre",
    "--dagre-nodesep",
    "40",
    "--dagre-edgesep",
    "20",
    "--theme",
    "0",
    "--dark-theme",
    "200",
    "--pad",
    "40",
    "--timeout",
    "10",
    "--stdout-format",
    "svg",
    "input.d2",
    "-",
  ]);
  // ELK options would be ignored by dagre, so passing them would only mislead a reader.
  assert.equal(
    calls.at(-1).args.some((argument) => argument.startsWith("--elk-")),
    false,
  );
});

test("each profile renders with its own engine, theme, and spacing", async () => {
  const drawn = new Map();
  for (const name of PROFILE_NAMES) {
    const { d2, calls } = cli({ render: { stdout: VALID_SVG } });
    await d2.renderSvg({ source: "a -> b", profile: parseProfile(name), signal: undefined });
    const args = calls.at(-1).args;
    const read = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    drawn.set(name, {
      engine: read("--layout"),
      theme: read("--theme"),
      pad: read("--pad"),
      sketch: args.includes("--sketch"),
      gap: read("--elk-nodeNodeBetweenLayers") ?? read("--dagre-nodesep"),
      edgeGap: read("--elk-edgeNodeBetweenLayers") ?? read("--dagre-edgesep"),
    });
  }

  assert.deepEqual(drawn.get("explain"), {
    engine: "elk",
    theme: "0",
    pad: "30",
    sketch: true,
    gap: "60",
    edgeGap: "40",
  });
  assert.deepEqual(drawn.get("architecture"), {
    engine: "elk",
    theme: "0",
    pad: "60",
    sketch: false,
    gap: "90",
    edgeGap: "50",
  });
  assert.deepEqual(drawn.get("data"), {
    engine: "elk",
    theme: "0",
    pad: "30",
    sketch: false,
    gap: "50",
    edgeGap: "30",
  });
  assert.deepEqual(drawn.get("docs"), {
    engine: "elk",
    theme: "1",
    pad: "100",
    sketch: false,
    gap: "80",
    edgeGap: "40",
  });
  assert.deepEqual(drawn.get("tree"), {
    engine: "dagre",
    theme: "0",
    pad: "40",
    sketch: false,
    gap: "40",
    edgeGap: "20",
  });
  assert.deepEqual(drawn.get("c4"), {
    engine: "elk",
    theme: "303",
    pad: "60",
    sketch: false,
    gap: "90",
    edgeGap: "50",
  });
  assert.deepEqual(drawn.get("dependency"), {
    engine: "elk",
    theme: "0",
    pad: "20",
    sketch: false,
    gap: "40",
    edgeGap: "20",
  });

  assert.deepEqual(
    [...drawn].filter(([, flags]) => flags.sketch).map(([name]) => name),
    ["explain"],
  );
});

test("a text render asks for no theme or spacing, which D2 would ignore", async () => {
  const { d2, calls } = cli({ render: { stdout: UNICODE_DIAGRAM } });
  await d2.renderText({ source: "a -> b", asciiMode: "extended", signal: undefined });
  const args = calls.at(-1).args;
  for (const flag of ["--theme", "--dark-theme", "--pad", "--elk-nodeNodeBetweenLayers"]) {
    assert.equal(args.includes(flag), false, flag);
  }
});

test("an SVG render validates the source first, like a text render", async () => {
  const { d2 } = cli({
    validate: { exitCode: 1, stderr: "err: github.com/d2lang/d2/d2cli.validateCmd: 1:1: bad\n" },
  });
  await assert.rejects(
    d2.renderSvg({ source: "a -> b", profile: DEFAULT_PROFILE, signal: undefined }),
    {
      name: "DiagramSourceError",
      message: /D2_SYNTAX/,
    },
  );
});

/** A client over a cache of its own, so one test cannot serve another one's output. */
async function cachedCli(options) {
  const directory = await mkdtemp(join(tmpdir(), "pi-diagram-runner-cache-"));
  const { runner, calls } = createRunner(options);
  return {
    d2: new D2Cli({ runner, binary: "d2", cache: new FileCache({ directory }) }),
    calls,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

const spawns = (calls) => calls.map((call) => call.args[0]);

test("a diagram already drawn is not drawn again", async () => {
  const { d2, calls, cleanup } = await cachedCli();
  try {
    const first = await d2.renderText(request());
    const before = calls.length;
    const second = await d2.renderText(request());

    assert.equal(second.text, first.text);
    assert.equal(calls.length, before, spawns(calls).join(" "));
  } finally {
    await cleanup();
  }
});

test("a cache is not shared between two clients of different binaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-diagram-runner-cache-"));
  try {
    const one = createRunner();
    await new D2Cli({
      runner: one.runner,
      binary: "d2",
      cache: new FileCache({ directory }),
    }).renderText(request());

    const other = createRunner();
    await new D2Cli({
      runner: other.runner,
      binary: "/opt/local/bin/d2",
      cache: new FileCache({ directory }),
    }).renderText(request());
    assert.ok(spawns(other.calls).includes("--layout"), spawns(other.calls).join(" "));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the same source under another profile is drawn again", async () => {
  const { d2, calls, cleanup } = await cachedCli({ render: { stdout: VALID_SVG } });
  try {
    await d2.renderSvg({ source: "a -> b", profile: parseProfile("explain"), signal: undefined });
    const before = calls.length;
    await d2.renderSvg({ source: "a -> b", profile: parseProfile("docs"), signal: undefined });
    assert.ok(calls.length > before, "the profile is not in the key");
  } finally {
    await cleanup();
  }
});

test("one call validates a source once, however many ways it is drawn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-diagram-runner-cache-"));
  const calls = [];
  const d2 = new D2Cli({
    binary: "d2",
    cache: new FileCache({ directory }),
    runner: (command, args) => {
      calls.push({ command, args });
      const mode = args.includes("standard") ? ASCII_DIAGRAM : UNICODE_DIAGRAM;
      const stdout = args[0] === "--version" ? "v0.8.1" : mode;
      return Promise.resolve({ command, args, exitCode: 0, stdout, stderr: "" });
    },
  });
  try {
    await d2.renderText(request());
    await d2.renderText(request("a -> b", "standard"));
    assert.equal(
      spawns(calls).filter((argument) => argument === "validate").length,
      1,
      spawns(calls).join(" "),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an entry this build cannot read is drawn again rather than returned", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-diagram-runner-cache-"));
  try {
    const cache = new FileCache({ directory });
    const { runner, calls } = createRunner();
    const d2 = new D2Cli({ runner, binary: "d2", cache });
    const drawn = await d2.renderText(request());

    // Every entry in this store belongs to that one source.
    for (const name of await readdir(directory)) {
      await writeFile(join(directory, name), "not a diagram");
    }

    const before = calls.length;
    const again = await d2.renderText(request());
    assert.equal(again.text, drawn.text);
    assert.ok(calls.length > before, "a corrupt entry was returned");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a cancelled call is not answered from the cache", async () => {
  const { d2, cleanup } = await cachedCli();
  try {
    await d2.renderText(request());
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(d2.renderText({ ...request(), signal: controller.signal }), {
      name: "CommandCancelledError",
    });
  } finally {
    await cleanup();
  }
});
