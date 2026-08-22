import type { Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { describeUnknown, hasErrnoCode } from "./unknown.js";

const MAX_CONFIG_BYTES = 4 * 1024;
const CONFIG_FILE = "pi-diagram.json";

export type RenderPreference = "image" | "unicode";
type DiagramHost = "pi" | "omp";

export interface RenderPreferenceOptions {
  readonly cwd?: string;
  readonly host?: DiagramHost;
  readonly agentDir?: string;
  readonly envPreference?: unknown;
  readonly entry?: string;
}

export function parseRenderPreference(value: unknown): RenderPreference {
  if (value === undefined || value === "unicode") {
    return "unicode";
  }
  if (value === "image") {
    return "image";
  }
  throw new Error(
    `Diagram render preference must be "unicode" or "image", not ${describeUnknown(value)}.`,
  );
}

function detectedHost(entry: string | undefined = process.argv[1]): DiagramHost {
  const executable = basename(entry ?? "")
    .toLowerCase()
    .replace(/\.exe$/u, "");
  if (executable === "pi" || executable === "omp") {
    return executable;
  }
  return "bun" in process.versions ? "omp" : "pi";
}

function defaultAgentDir(host: DiagramHost): string {
  return join(homedir(), host === "omp" ? ".omp" : ".pi", "agent");
}

async function readPreference(path: string): Promise<RenderPreference | undefined> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  if (!info.isFile() || info.size > MAX_CONFIG_BYTES) {
    throw new Error(
      `${JSON.stringify(path)} must be a regular file no larger than ${MAX_CONFIG_BYTES} bytes.`,
    );
  }

  const raw = await readFile(path, "utf8");
  if (Buffer.byteLength(raw) > MAX_CONFIG_BYTES) {
    throw new Error(`${JSON.stringify(path)} is larger than ${MAX_CONFIG_BYTES} bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${JSON.stringify(path)} is not valid JSON.`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${JSON.stringify(path)} must contain a JSON object.`);
  }
  const keys = Object.keys(parsed);
  if (keys.some((key) => key !== "render")) {
    throw new Error(`${JSON.stringify(path)} supports only the "render" setting.`);
  }
  const render = Object.hasOwn(parsed, "render") ? Reflect.get(parsed, "render") : undefined;
  return parseRenderPreference(render);
}

export async function resolveRenderPreference(
  options: RenderPreferenceOptions = {},
): Promise<RenderPreference> {
  const environmentPreference = Object.hasOwn(options, "envPreference")
    ? options.envPreference
    : process.env.PI_DIAGRAM_RENDER;
  if (environmentPreference !== undefined) {
    return parseRenderPreference(environmentPreference);
  }

  const host = options.host ?? detectedHost(options.entry);
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? defaultAgentDir(host);
  const projectPreference = await readPreference(
    join(cwd, host === "omp" ? ".omp" : ".pi", CONFIG_FILE),
  );
  if (projectPreference !== undefined) {
    return projectPreference;
  }
  return parseRenderPreference(await readPreference(join(agentDir, CONFIG_FILE)));
}
