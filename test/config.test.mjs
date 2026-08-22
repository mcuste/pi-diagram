import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseRenderPreference, resolveRenderPreference } from "../dist/config.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-config-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  return { root, cwd, agentDir };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

test("Unicode is the default render preference", async () => {
  const paths = await fixture();
  try {
    assert.equal(
      await resolveRenderPreference({ ...paths, host: "pi", envPreference: undefined }),
      "unicode",
    );
    assert.equal(parseRenderPreference(undefined), "unicode");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("an unprintable preference value still produces a configuration error", () => {
  assert.throws(() => parseRenderPreference(1n), /1n/);
});

test("project configuration overrides global configuration", async () => {
  const paths = await fixture();
  try {
    await writeJson(join(paths.agentDir, "pi-diagram.json"), { render: "image" });
    assert.equal(
      await resolveRenderPreference({
        ...paths,
        host: "pi",
        envPreference: undefined,
      }),
      "image",
    );
    await writeJson(join(paths.cwd, ".pi", "pi-diagram.json"), { render: "unicode" });
    assert.equal(
      await resolveRenderPreference({
        ...paths,
        host: "pi",
        envPreference: undefined,
      }),
      "unicode",
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("a valid project preference does not read an invalid shadowed global file", async () => {
  const paths = await fixture();
  try {
    await writeJson(join(paths.agentDir, "pi-diagram.json"), { render: "ascii" });
    await writeJson(join(paths.cwd, ".pi", "pi-diagram.json"), { render: "image" });
    assert.equal(
      await resolveRenderPreference({ ...paths, host: "pi", envPreference: undefined }),
      "image",
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("Pi and OMP use their own project configuration directories", async () => {
  const paths = await fixture();
  try {
    await writeJson(join(paths.cwd, ".pi", "pi-diagram.json"), { render: "image" });
    await writeJson(join(paths.cwd, ".omp", "pi-diagram.json"), { render: "unicode" });
    assert.equal(
      await resolveRenderPreference({ ...paths, host: "pi", envPreference: undefined }),
      "image",
    );
    assert.equal(
      await resolveRenderPreference({ ...paths, host: "omp", envPreference: undefined }),
      "unicode",
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("the Pi executable selects Pi configuration in a Bun runtime", async () => {
  const paths = await fixture();
  const previous = Object.getOwnPropertyDescriptor(process.versions, "bun");
  try {
    await writeJson(join(paths.cwd, ".pi", "pi-diagram.json"), { render: "image" });
    await writeJson(join(paths.cwd, ".omp", "pi-diagram.json"), { render: "unicode" });
    Object.defineProperty(process.versions, "bun", {
      configurable: true,
      value: "1.3.0",
    });
    assert.equal(
      await resolveRenderPreference({
        ...paths,
        entry: "/usr/local/bin/pi",
        envPreference: undefined,
      }),
      "image",
    );
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.versions, "bun");
    } else {
      Object.defineProperty(process.versions, "bun", previous);
    }
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("environment preference overrides persistent configuration", async () => {
  const paths = await fixture();
  try {
    await writeJson(join(paths.cwd, ".pi", "pi-diagram.json"), { render: "unicode" });
    assert.equal(
      await resolveRenderPreference({ ...paths, host: "pi", envPreference: "image" }),
      "image",
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("invalid configuration is refused", async () => {
  const paths = await fixture();
  try {
    const config = join(paths.cwd, ".pi", "pi-diagram.json");
    await writeJson(config, { render: "ascii" });
    await assert.rejects(
      resolveRenderPreference({ ...paths, host: "pi", envPreference: undefined }),
      /unicode.*image/,
    );
    await writeJson(config, { render: "image", extra: true });
    await assert.rejects(
      resolveRenderPreference({ ...paths, host: "pi", envPreference: undefined }),
      /only the "render"/,
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
