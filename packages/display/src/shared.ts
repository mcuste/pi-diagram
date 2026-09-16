import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { isRecord, isSessionArtifactPath, parseRenderedPng } from "@mcuste/pi-diagram-core";
import type { Component, DiagramCallView, DisplayImage, DisplayTheme } from "./contracts.js";
import { ELLIPSIS, truncateWithoutHost } from "./truncate.js";

const PREVIEW_MAX_WIDTH_CELLS = 60;
export const PREVIEW_MAX_HEIGHT_CELLS = 18;
export const UNBOUNDED_WIDTH_CELLS = Number.MAX_SAFE_INTEGER;

/** Both renderers report the same limitation, and only once per result. */
export const IMAGE_UNAVAILABLE_WARNING = "This terminal cannot display inline images.";

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
  readonly truncateToWidth?: (text: string, width: number, ellipsis?: string) => string;
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

  render(width: number): string[] {
    return this.text.split("\n").map((line) => truncateLine(line, width));
  }

  /** Nothing is cached between renders, so there is nothing to clear. */
  invalidate(): void {}
}

/** Pi stops when a rendered line is wider than the terminal. */
function truncateLine(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  const truncate = tui?.truncateToWidth;
  return truncate === undefined
    ? truncateWithoutHost(text, width)
    : truncate(text, width, ELLIPSIS);
}

export class StackComponent implements Component {
  private readonly children: Component[] = [];

  addChild(child: Component): void {
    this.children.push(child);
  }

  render(width: number): string[] {
    return this.children.flatMap((child) => child.render(width));
  }

  /** The host builds the image child, so tolerate one that does not invalidate. */
  invalidate(): void {
    for (const child of this.children) {
      child.invalidate?.();
    }
  }
}

/** A stack that writes its text in the two colors a result row uses. */
export class ResultComponent extends StackComponent {
  private readonly theme: DisplayTheme;

  constructor(theme: DisplayTheme) {
    super();
    this.theme = theme;
  }

  line(text: string): void {
    this.addChild(new TextComponent(this.theme.fg("toolOutput", text)));
  }

  muted(text: string): void {
    this.addChild(new TextComponent(this.theme.fg("muted", text)));
  }
}

/** Reports a limitation the renderer found, unless the render already reported it. */
export function appendWarning(
  notes: readonly string[],
  warning: string | undefined,
): readonly string[] {
  return warning === undefined || notes.includes(warning) ? notes : [...notes, warning];
}

/** Per-result state for a host that keeps none of its own. */
const fallbackStates = new WeakMap<object, Record<string, unknown>>();

export function fallbackState(key: object): Record<string, unknown> {
  let state = fallbackStates.get(key);
  if (state === undefined) {
    state = {};
    fallbackStates.set(key, state);
  }
  return state;
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

/** Load the host TUI and run its terminal detection before the first render. */
export function primeDisplay(): Promise<void> {
  if (tui !== undefined) {
    return Promise.resolve();
  }
  if (tuiLoading !== undefined) {
    return tuiLoading;
  }
  const specifier = tuiSpecifier(process.argv[1]);
  tuiLoading = loadTui(specifier).then((module) => {
    tui = parseTuiModule(module);
    readCapabilities(module);
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
  const supported = currentCapabilities();
  return supported === undefined ? undefined : supported.images !== null;
}

/** What the loaded host TUI reports about this terminal, if one loaded at all. */
function currentCapabilities(): ImageCapabilities | undefined {
  return tui === undefined ? undefined : readCapabilities(tui);
}

/** The compact image both renderers show beside a result. */
export function createPreviewImage(
  image: DisplayImage,
  theme: DisplayTheme,
  state: Record<string, unknown>,
): Component | undefined {
  return createImage(image, theme, state, {
    maxWidthCells: PREVIEW_MAX_WIDTH_CELLS,
    maxHeightCells: PREVIEW_MAX_HEIGHT_CELLS,
    filename: image.path,
  });
}

export function createImage(
  image: DisplayImage,
  theme: DisplayTheme,
  state: Record<string, unknown>,
  options: ImageOptions,
): Component | undefined {
  const module = tui;
  const supported = currentCapabilities();
  if (
    module === undefined ||
    supported === undefined ||
    supported.images === null ||
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
  return currentCapabilities()?.hyperlinks === true && isSessionArtifactPath(image.path)
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
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.Image === "function" ? (value as unknown as TuiModule) : undefined;
}

function readCapabilities(value: unknown): ImageCapabilities | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const getCapabilities = value.getCapabilities;
  if (typeof getCapabilities === "function") {
    try {
      return parseCapabilities(getCapabilities());
    } catch {
      return undefined;
    }
  }
  return parseCapabilities(value.TERMINAL, true);
}

function parseCapabilities(value: unknown, terminal = false): ImageCapabilities | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const imageValue = terminal ? value.imageProtocol : value.images;
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
  return images !== undefined && typeof value.hyperlinks === "boolean"
    ? { images, hyperlinks: value.hyperlinks }
    : undefined;
}

function readImage(image: DisplayImage, state: Record<string, unknown>): string {
  if (!isSessionArtifactPath(image.path)) {
    throw new Error("The image is not in this process's private store.");
  }
  const cached = state.diagramImage;
  if (isRecord(cached) && cached.path === image.path && typeof cached.encoded === "string") {
    return cached.encoded;
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
