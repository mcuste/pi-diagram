import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Removes a path and ignores every failure, where a leftover file must not fail the call. */
export async function removeQuietly(path: string, recursive = false): Promise<void> {
  await rm(path, { force: true, recursive }).catch(() => undefined);
}

/**
 * Runs the work in a private directory and removes it afterwards. `mkdtemp` creates the
 * directory owner-only, so no other user of the machine can read what is staged there.
 */
export async function withTempDirectory<TResult>(
  prefix: string,
  use: (directory: string) => Promise<TResult>,
): Promise<TResult> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await use(directory);
  } finally {
    await removeQuietly(directory, true);
  }
}
