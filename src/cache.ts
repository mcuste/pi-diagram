import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Holds what a renderer returned, keyed by everything that decided it. A render costs a subprocess
 * of a few hundred milliseconds, and the same diagram is usually drawn more than once.
 */

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/u;
const ENTRY_SUFFIX = ".cache";

export interface CacheKeyParts {
  readonly source: string;
  readonly language: "d2";
  /** Which renderer ran. Two builds can report the same version from different paths. */
  readonly binary: string;
  /** So no output is served after a D2 upgrade. */
  readonly version: string;
  /**
   * Carries the engine, theme, and spacing a profile chose, so a policy change cannot serve a
   * picture drawn under the old one.
   */
  readonly argv: readonly string[];
}

export interface RenderCache {
  read(key: string): Promise<string | undefined>;
  write(key: string, value: string): Promise<void>;
}

export function cacheKey(parts: CacheKeyParts): string {
  return cacheKeyOf([parts.language, parts.binary, parts.version, ...parts.argv, parts.source]);
}

/** Length-prefixed, so no two field lists can read as one another. */
export function cacheKeyOf(fields: readonly string[]): string {
  const hash = createHash("sha256");
  for (const field of fields) {
    hash.update(`${field.length}:${field}`, "utf8");
  }
  return hash.digest("hex");
}

/** Keeps nothing. For tests, and for callers that want every render to run. */
export const noCache: RenderCache = {
  read: () => Promise.resolve(undefined),
  write: () => Promise.resolve(),
};

export interface FileCacheOptions {
  readonly directory?: string;
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
}

/**
 * Entries on disk, outside the project, shared between sessions. Every operation is best-effort: a
 * cache that cannot be read or written must not fail a diagram.
 */
export class FileCache implements RenderCache {
  private readonly directory: string;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;

  constructor(options: FileCacheOptions = {}) {
    this.directory = options.directory ?? join(tmpdir(), "pi-diagram-cache");
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  async read(key: string): Promise<string | undefined> {
    const path = this.pathFor(key);
    if (path === undefined) {
      return undefined;
    }
    try {
      if (!(await this.usableDirectory())) {
        return undefined;
      }
      const found = await lstat(path);
      if (!found.isFile() || found.size > MAX_ENTRY_BYTES || this.expired(found.mtimeMs)) {
        await rm(path, { force: true }).catch(() => undefined);
        return undefined;
      }
      const value = await readFile(path, "utf8");
      if (Buffer.byteLength(value, "utf8") > MAX_ENTRY_BYTES) {
        await rm(path, { force: true }).catch(() => undefined);
        return undefined;
      }
      // Touched on use, so eviction drops what nobody draws any more.
      const now = new Date();
      await utimes(path, now, now).catch(() => undefined);
      return value;
    } catch {
      return undefined;
    }
  }

  async write(key: string, value: string): Promise<void> {
    const destination = this.pathFor(key);
    if (destination === undefined || Buffer.byteLength(value, "utf8") > MAX_ENTRY_BYTES) {
      return;
    }
    const temporary = join(this.directory, `${randomUUID()}.part`);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (!(await this.usableDirectory())) {
        return;
      }
      await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
      // Renamed into place, so a reader never sees half a diagram.
      await rename(temporary, destination);
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      return;
    }
    await this.prune();
  }

  /** Drops entries past the age limit, then the least recently used until the size fits. */
  private async prune(): Promise<void> {
    try {
      const names = await readdir(this.directory);
      const entries: { path: string; bytes: number; usedAt: number }[] = [];
      for (const name of names) {
        if (!this.isEntryName(name)) {
          continue;
        }
        const path = join(this.directory, name);
        const found = await lstat(path).catch(() => undefined);
        if (found === undefined || !found.isFile()) {
          continue;
        }
        if (found.size > MAX_ENTRY_BYTES || this.expired(found.mtimeMs)) {
          await rm(path, { force: true }).catch(() => undefined);
          continue;
        }
        entries.push({ path, bytes: found.size, usedAt: found.mtimeMs });
      }

      let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
      if (total <= this.maxBytes) {
        return;
      }
      for (const entry of entries.sort((left, right) => left.usedAt - right.usedAt)) {
        if (total <= this.maxBytes) {
          return;
        }
        await rm(entry.path, { force: true }).catch(() => undefined);
        total -= entry.bytes;
      }
    } catch {
      // Nothing to prune, or a directory this process cannot read.
    }
  }

  private async usableDirectory(): Promise<boolean> {
    const directory = await lstat(this.directory);
    return directory.isDirectory() && (directory.mode & 0o077) === 0;
  }

  private expired(usedAt: number): boolean {
    return usedAt < Date.now() - this.maxAgeMs;
  }

  private pathFor(key: string): string | undefined {
    return SAFE_KEY.test(key) ? join(this.directory, `${key}${ENTRY_SUFFIX}`) : undefined;
  }

  private isEntryName(name: string): boolean {
    return name.endsWith(ENTRY_SUFFIX) && SAFE_KEY.test(name.slice(0, -ENTRY_SUFFIX.length));
  }
}
