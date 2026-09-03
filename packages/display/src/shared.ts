import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { isSessionArtifactPath, parseRenderedPng } from "@mcuste/pi-diagram-core";
import type { Component, DiagramCallView, DisplayImage, DisplayTheme } from "./contracts.js";

export const PREVIEW_MAX_WIDTH_CELLS = 60;
export const PREVIEW_MAX_HEIGHT_CELLS = 18;
export const UNBOUNDED_WIDTH_CELLS = Number.MAX_SAFE_INTEGER;

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const TUI_PACKAGES = ["@earendil-works/pi-tui", "@oh-my-pi/pi-tui"] as const;

type ImageProtocol = "kitty" | "iterm2" | "sixel";

interface ImageCapabilities {
  readonly images: ImageProtocol | null;
  readonly hyperlinks: boolean;
}

interface ImageOptions {
  readonly maxWidthCells: number;
  readonly maxHeightCells: number;
  readonly filename: string;
  readonly budget?: unknown;
  readonly imageKey?: string;
}

interface TuiModule {
  readonly getCapabilities?: () => unknown;
  readonly TERMINAL?: unknown;
  readonly hyperlink?: (text: string, url: string) => string;
  readonly Image: new (
    base64Data: string,
    mimeType: string,
    theme: { fallbackColor: (text: string) => string },
    options?: ImageOptions,
    dimensions?: { widthPx: number; heightPx: number },
  ) => Component;
}

export class TextComponent implements Component {
  constructor(private readonly text: string) {}

  render(): string[] {
    return this.text.split("\n");
  }
}

export class StackComponent implements Component {
  private readonly children: Component[] = [];

  addChild(child: Component): void {
    this.children.push(child);
  }

  render(width: number): string[] {
    return this.children.flatMap((child) => child.render(width));
  }
}

let tui: TuiModule | undefined;
let tuiLoading: Promise<void> | undefined;

/** Resolve from the host so its TUI version wins. */
export function tuiSpecifier(entry: string | undefined): string | undefined {
  if (entry === undefined) {
    return undefined;
  }
  try {
    const require = createRequire(realpathSync(entry));
    for (const packageName of TUI_PACKAGES) {
      try {
        return pathToFileURL(require.resolve(packageName)).href;
      } catch {}
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Load terminal capabilities before tool rendering. */
export function primeDisplay(): Promise<void> {
  if (tui !== undefined) {
    return Promise.resolve();
  }
  if (tuiLoading !== undefined) {
    return tuiLoading;
  }
  const specifier = tuiSpecifier(process.argv[1]);
  tuiLoading = loadTui(specifier).then((module) => {
    const candidate = parseTuiModule(module);
    if (candidate !== undefined && capabilities(candidate) !== undefined) {
      tui = candidate;
    } else {
      readCapabilities(module);
    }
  });
  return tuiLoading;
}

async function loadTui(specifier: string | undefined): Promise<unknown> {
  if (specifier !== undefined) {
    try {
      return await import(specifier);
    } catch {
      // Compiled OMP has no filesystem package path.
    }
  }
  // OMP rewrites this legacy literal to its bundled TUI.
  try {
    return await import("@earendil-works/pi-tui");
  } catch {
    return undefined;
  }
}

export function displayLoaded(): boolean {
  return true;
}

export function imagesSupported(): boolean | undefined {
  const supported = tui === undefined ? undefined : capabilities(tui);
  return supported === undefined ? undefined : supported.images !== null;
}

export function createImage(
  image: DisplayImage,
  theme: DisplayTheme,
  state: Record<string, unknown>,
  options: ImageOptions,
): Component | undefined {
  const module = tui;
  if (
    module === undefined ||
    capabilities(module)?.images === null ||
    !isSessionArtifactPath(image.path)
  ) {
    return undefined;
  }
  try {
    return new module.Image(
      readImage(image, state),
      "image/png",
      { fallbackColor: (text: string) => theme.fg("toolOutput", text) },
      options,
      { widthPx: image.widthPx, heightPx: image.heightPx },
    );
  } catch {
    return undefined;
  }
}

export function imageUrl(image: DisplayImage): string | undefined {
  const module = tui;
  return module !== undefined &&
    capabilities(module)?.hyperlinks === true &&
    isSessionArtifactPath(image.path)
    ? pathToFileURL(image.path).href
    : undefined;
}

export function hyperlink(text: string, url: string): string {
  return tui?.hyperlink?.(text, url) ?? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export function renderCall(view: DiagramCallView, theme: DisplayTheme): Component {
  const metadata = [
    view.profile,
    view.saveDirectory === undefined ? undefined : `saving into ${view.saveDirectory}`,
  ]
    .filter((value): value is string => value !== undefined)
    .join(", ");
  const text = [
    theme.fg("toolTitle", "diagram "),
    theme.fg("accent", view.subject),
    " ",
    theme.fg("muted", `(${metadata})`),
  ].join("");
  return new TextComponent(text);
}

function parseTuiModule(value: unknown): TuiModule | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.Image === "function" ? (candidate as unknown as TuiModule) : undefined;
}

function capabilities(module: TuiModule): ImageCapabilities | undefined {
  return readCapabilities(module);
}

function readCapabilities(value: unknown): ImageCapabilities | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const fields = value as Record<string, unknown>;
  const getCapabilities = fields.getCapabilities;
  if (typeof getCapabilities === "function") {
    try {
      return parseCapabilities(getCapabilities());
    } catch {
      return undefined;
    }
  }
  return parseCapabilities(fields.TERMINAL, true);
}

function parseCapabilities(value: unknown, terminal = false): ImageCapabilities | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const fields = value as Record<string, unknown>;
  const imageValue = terminal ? fields.imageProtocol : fields.images;
  const images =
    imageValue === "kitty" || imageValue === "\x1b_G"
      ? "kitty"
      : imageValue === "iterm2" || imageValue === "\x1b]1337;File="
        ? "iterm2"
        : imageValue === "sixel" || imageValue === "\x1bPq"
          ? "sixel"
          : imageValue === null
            ? null
            : undefined;
  return images !== undefined && typeof fields.hyperlinks === "boolean"
    ? { images, hyperlinks: fields.hyperlinks }
    : undefined;
}

function readImage(image: DisplayImage, state: Record<string, unknown>): string {
  if (!isSessionArtifactPath(image.path)) {
    throw new Error("The image is not in this process's private store.");
  }
  const cached = state.diagramImage;
  if (typeof cached === "object" && cached !== null) {
    const { path, encoded } = cached as { path?: unknown; encoded?: unknown };
    if (path === image.path && typeof encoded === "string") {
      return encoded;
    }
  }

  const bytes = readFileSync(image.path);
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`The image at ${image.path} is ${bytes.length} bytes.`);
  }
  const checked = parseRenderedPng(bytes, {
    widthPx: image.widthPx,
    heightPx: image.heightPx,
  });
  const encoded = Buffer.from(checked.png).toString("base64");
  state.diagramImage = { path: image.path, encoded };
  return encoded;
}
