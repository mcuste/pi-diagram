import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  parseArtifactNames,
  parseArtifactTarget,
  workspacePaths,
  writeArtifacts,
} from "../dist/artifacts.js";

const workspaces = [];

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-test-"));
  workspaces.push(root);
  return root;
}

after(async () => {
  for (const root of workspaces) {
    await rm(root, { recursive: true, force: true });
  }
});

const HASH = "abcdef0123456789".repeat(4);

/** Names for a repository write. */
function names({ dir = "docs/diagrams", basename, formats } = {}, title = "Request path") {
  return parseArtifactNames({ formats, save: { dir, basename } }, { title, hash: HASH });
}

/** Names for a diagram that stays out of the repository. */
function tempNames({ formats } = {}, title = undefined) {
  return parseArtifactNames({ formats }, { title, hash: HASH });
}

async function save(root, contents, options = {}) {
  const target = await parseArtifactTarget(root, names(options.save, options.title));
  return writeArtifacts(target, new Map(Object.entries(contents)));
}

test("editable source and an SVG are the default pair", () => {
  assert.deepEqual(names().formats, ["source", "svg"]);
  assert.equal(names().directory, "docs/diagrams");
});

test("a diagram stays out of the repository unless a directory is named", () => {
  assert.equal(tempNames().directory, undefined);
  assert.equal(names().directory, "docs/diagrams");
});

test("saving without a directory is refused, because no location is universal", () => {
  for (const dir of [undefined, "", "   ", 7]) {
    assert.throws(
      () => parseArtifactNames({ save: { dir } }, { title: "T", hash: HASH }),
      { name: "DiagramSourceError", message: /needs a directory|not usable/ },
      String(dir),
    );
  }
});

test("a diagram with no title is named from its source, but only outside the repository", () => {
  assert.equal(tempNames().basename, `diagram-${HASH.slice(0, 12)}`);
  assert.throws(
    () => parseArtifactNames({ save: { dir: "docs" } }, { title: undefined, hash: HASH }),
    {
      message: /needs a name/,
    },
  );
});

test("a title becomes a stable file name", () => {
  assert.equal(names({}, "Request Lifecycle!").basename, "request-lifecycle");
  assert.equal(names({}, "  API   ->   DB  ").basename, "api-db");
  assert.equal(names({}, "Café Ordering").basename, "cafe-ordering");
  assert.equal(names({ basename: "custom_name" }).basename, "custom-name");
});

test("a file name is bounded and never carries a path", () => {
  assert.equal(names({ basename: "x".repeat(200) }).basename.length, 60);
  assert.equal(names({ basename: "../../etc/passwd" }).basename, "etc-passwd");
  assert.equal(names({ basename: "a/b/c" }).basename, "a-b-c");
});

test("a name with nothing usable in it is refused, not invented", () => {
  assert.throws(() => names({ basename: "!!!" }, undefined), {
    name: "DiagramSourceError",
    message: /no letters or digits/,
  });
});

test("Windows device names are refused", () => {
  for (const reserved of ["con", "NUL", "com1", "LPT9", "aux"]) {
    assert.throws(() => names({ basename: reserved }), { message: /reserved device name/ });
  }
});

test("a PNG is named like any other artifact", () => {
  assert.deepEqual(workspacePaths(names({ dir: "docs", formats: ["png"] })), [
    "docs/request-path.png",
  ]);
});

test("unknown or empty format lists are refused", () => {
  for (const formats of [["pdf"], [], "svg", [7]]) {
    assert.throws(
      () => names({ formats }),
      { name: "DiagramSourceError" },
      JSON.stringify(formats),
    );
  }
});

test("duplicate formats collapse and order is kept", () => {
  assert.deepEqual(names({ formats: ["svg", "source", "svg"] }).formats, ["svg", "source"]);
});

test("repository paths are previewed before anything is written", () => {
  assert.deepEqual(workspacePaths(names({ dir: "docs/arch" })), [
    "docs/arch/request-path.d2",
    "docs/arch/request-path.svg",
  ]);
  assert.deepEqual(workspacePaths(names({ dir: "." })), ["request-path.d2", "request-path.svg"]);
});

test("a diagram kept out of the repository previews no repository paths", () => {
  assert.deepEqual(workspacePaths(tempNames()), []);
});

test("a directory outside the workspace is refused", () => {
  for (const dir of ["../etc", "docs/../../etc", "/etc", "/"]) {
    assert.throws(() => names({ dir }), { name: "DiagramSourceError" }, dir);
  }
});

test("the temp store is bounded so a long session cannot fill it", async () => {
  const target = await parseArtifactTarget(undefined, tempNames({ formats: ["txt"] }));
  for (let index = 0; index < 70; index += 1) {
    await writeArtifacts(
      await parseArtifactTarget(
        undefined,
        parseArtifactNames(
          { formats: ["txt"] },
          {
            title: undefined,
            hash: `${index}`.padStart(64, "0"),
          },
        ),
      ),
      new Map([["txt", `diagram ${index}`]]),
    );
  }
  const kept = await readdir(target.directory);
  assert.ok(kept.length <= 64, `kept ${kept.length} files`);
});

test("save options that are not an object are refused", () => {
  for (const value of [[], "docs", 7, null]) {
    assert.throws(() => parseArtifactNames({ save: value }, { title: "T", hash: HASH }), {
      name: "DiagramSourceError",
    });
  }
});

test("a repository write without a workspace directory is refused", async () => {
  for (const cwd of [undefined, "", "relative/path", 7]) {
    await assert.rejects(parseArtifactTarget(cwd, names()), { name: "DiagramSourceError" });
  }
});

test("a diagram kept out of the repository needs no workspace at all", async () => {
  const target = await parseArtifactTarget(undefined, tempNames({ formats: ["svg"] }));
  assert.equal(target.location, "temp");
  const written = await writeArtifacts(target, new Map([["svg", "<svg></svg>"]]));
  assert.equal(written[0].location, "temp");
  assert.ok(written[0].path.startsWith(tmpdir()), written[0].path);
  assert.equal(await readFile(written[0].path, "utf8"), "<svg></svg>");
});

test("files land in the workspace and their paths come back relative", async () => {
  const root = await workspace();
  const written = await save(root, { source: "a -> b", svg: "<svg></svg>" });

  assert.deepEqual(written, [
    { format: "source", location: "workspace", path: "docs/diagrams/request-path.d2" },
    { format: "svg", location: "workspace", path: "docs/diagrams/request-path.svg" },
  ]);
  assert.equal(await readFile(join(root, "docs/diagrams/request-path.d2"), "utf8"), "a -> b");
  assert.equal(await readFile(join(root, "docs/diagrams/request-path.svg"), "utf8"), "<svg></svg>");
});

test("a format with no content is skipped rather than written empty", async () => {
  const root = await workspace();
  const written = await save(root, { source: "a -> b" }, { save: { formats: ["source", "svg"] } });
  assert.deepEqual(
    written.map((artifact) => artifact.format),
    ["source"],
  );
  assert.deepEqual(await readdir(join(root, "docs/diagrams")), ["request-path.d2"]);
});

test("regenerating a diagram replaces its own files and leaves no temporary behind", async () => {
  const root = await workspace();
  await save(root, { source: "a -> b" }, { save: { formats: ["source"] } });
  await save(root, { source: "a -> c" }, { save: { formats: ["source"] } });

  assert.equal(await readFile(join(root, "docs/diagrams/request-path.d2"), "utf8"), "a -> c");
  assert.deepEqual(await readdir(join(root, "docs/diagrams")), ["request-path.d2"]);
});

test("a symlinked directory cannot redirect a write out of the workspace", async () => {
  const root = await workspace();
  const outside = await workspace();
  await symlink(outside, join(root, "docs"));

  await assert.rejects(save(root, { source: "a -> b" }), {
    name: "DiagramSourceError",
    message: /leaves the workspace.*symbolic link/s,
  });
  assert.deepEqual(await readdir(outside), [], "the write reached outside the workspace");
});

test("an existing path that is not a plain file is never overwritten", async () => {
  const root = await workspace();
  const outside = await workspace();
  await mkdir(join(root, "docs/diagrams"), { recursive: true });
  await writeFile(join(outside, "target.d2"), "original", "utf8");
  await symlink(join(outside, "target.d2"), join(root, "docs/diagrams/request-path.d2"));

  await assert.rejects(save(root, { source: "a -> b" }, { save: { formats: ["source"] } }), {
    name: "DiagramSourceError",
    message: /not a regular file/,
  });
  assert.equal(await readFile(join(outside, "target.d2"), "utf8"), "original");
});

test("a directory in the way of a diagram file is refused", async () => {
  const root = await workspace();
  await mkdir(join(root, "docs/diagrams/request-path.d2"), { recursive: true });
  await assert.rejects(save(root, { source: "a -> b" }, { save: { formats: ["source"] } }), {
    message: /not a regular file/,
  });
});

test("nested directories are created on demand", async () => {
  const root = await workspace();
  const written = await save(
    root,
    { source: "a -> b" },
    { save: { dir: "docs/design/diagrams/v2", formats: ["source"] } },
  );
  assert.equal(written[0].path, "docs/design/diagrams/v2/request-path.d2");
});
