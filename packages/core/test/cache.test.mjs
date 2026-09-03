import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cacheKey, FileCache, noCache } from "../dist/cache.js";

const PARTS = {
  source: "a -> b",
  language: "d2",
  binary: "d2",
  version: "v0.8.1",
  argv: ["--layout", "elk", "--theme", "0"],
};

async function store(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-diagram-cache-test-"));
  return { directory, cache: new FileCache({ directory, ...options }) };
}

function cachePath(directory, key) {
  return join(directory, `${key}.cache`);
}

test("the same render asks for the same entry", () => {
  assert.equal(cacheKey(PARTS), cacheKey({ ...PARTS }));
  assert.match(cacheKey(PARTS), /^[0-9a-f]{64}$/);
});

test("anything that changes the picture changes the entry", () => {
  const keys = new Set([
    cacheKey(PARTS),
    cacheKey({ ...PARTS, source: "a -> c" }),
    cacheKey({ ...PARTS, binary: "/opt/homebrew/bin/d2" }),
    cacheKey({ ...PARTS, version: "v0.9.0" }),
    // A profile reaches D2 as arguments, so its policy is in the key through them.
    cacheKey({ ...PARTS, argv: ["--layout", "elk", "--theme", "1"] }),
    cacheKey({ ...PARTS, argv: ["--layout", "dagre", "--theme", "0"] }),
    cacheKey({ ...PARTS, argv: [...PARTS.argv, "--sketch"] }),
  ]);
  assert.equal(keys.size, 7);
});

test("arguments cannot be rearranged into another entry", () => {
  assert.notEqual(
    cacheKey({ ...PARTS, argv: ["--theme", "00"] }),
    cacheKey({ ...PARTS, argv: ["--theme0", "0"] }),
  );
  assert.notEqual(cacheKey({ ...PARTS, argv: ["a", "b"] }), cacheKey({ ...PARTS, argv: ["a b"] }));
});

test("what was written comes back, and an unknown key does not", async () => {
  const { directory, cache } = await store();
  try {
    await cache.write("abc", "<svg/>");
    assert.equal(await cache.read("abc"), "<svg/>");
    assert.equal(await cache.read("def"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a cache that cannot be written is not a failure", async () => {
  // A path inside a regular file can hold no directory.
  const root = await mkdtemp(join(tmpdir(), "pi-diagram-cache-test-"));
  try {
    const file = join(root, "not-a-directory");
    await writeFile(file, "");
    const cache = new FileCache({ directory: join(file, "cache") });
    await cache.write("abc", "<svg/>");
    assert.equal(await cache.read("abc"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nothing half written is left behind", async () => {
  const { directory, cache } = await store();
  try {
    await cache.write("abc", "<svg/>");
    assert.deepEqual(await readdir(directory), ["abc.cache"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pruning leaves non-cache files in its directory alone", async () => {
  const { directory } = await store();
  const note = join(directory, "notes.txt");
  try {
    await writeFile(note, "keep");
    await new FileCache({ directory, maxBytes: 1 }).write("abc", "0123456789");
    assert.equal(await readFile(note, "utf8"), "keep");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the least recently used entries go first when the store is full", async () => {
  // Filled with room to spare, then bounded, so setup cannot evict what the test is about.
  const { directory, cache } = await store();
  try {
    for (const key of ["read-recently", "written-recently", "untouched"]) {
      await cache.write(key, "0123456789");
    }
    // Set by hand, because three writes can land in the same millisecond.
    const at = async (key, agoMs) => {
      const when = new Date(Date.now() - agoMs);
      await utimes(cachePath(directory, key), when, when);
    };
    await at("untouched", 30_000);
    await at("written-recently", 20_000);
    await at("read-recently", 10_000);

    await new FileCache({ directory, maxBytes: 25 }).write("trigger", "x");
    const kept = (await readdir(directory)).sort();
    assert.deepEqual(
      kept,
      ["read-recently.cache", "trigger.cache", "written-recently.cache"],
      kept.join(" "),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("entries past the age limit are dropped", async () => {
  const { directory, cache } = await store({ maxAgeMs: 1000 });
  try {
    await cache.write("stale", "<svg/>");
    const old = new Date(Date.now() - 60_000);
    await utimes(cachePath(directory, "stale"), old, old);

    await cache.write("fresh", "<svg/>");
    assert.deepEqual(await readdir(directory), ["fresh.cache"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an expired entry is never served and cannot become fresh again", async () => {
  const { directory, cache } = await store({ maxAgeMs: 1000 });
  try {
    await cache.write("stale", "<svg/>");
    const old = new Date(Date.now() - 60_000);
    await utimes(cachePath(directory, "stale"), old, old);
    assert.equal(await cache.read("stale"), undefined);
    await assert.rejects(stat(cachePath(directory, "stale")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a read marks an entry as used", async () => {
  const { directory, cache } = await store();
  try {
    await cache.write("abc", "<svg/>");
    const path = cachePath(directory, "abc");
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old);

    await cache.read("abc");
    assert.ok((await stat(path)).mtimeMs > Date.now() - 10_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the empty cache keeps nothing", async () => {
  await noCache.write("abc", "<svg/>");
  assert.equal(await noCache.read("abc"), undefined);
});
