import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { isSessionArtifactPath } from "./artifacts.js";

/**
 * Turns a diagram result into terminal components. Both the image and the text are drawn here
 * rather than by the host, so neither has to travel back through the model's context. The image is
 * read from the temp store at display time.
 */

const PREVIEW_MAX_WIDTH_CELLS = 60;
const PREVIEW_MAX_HEIGHT_CELLS = 18;
const ZOOM_MAX_HEIGHT_CELLS = 60;
const UNBOUNDED_WIDTH_CELLS = Number.MAX_SAFE_INTEGER;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export interface Component {
  render(width: number): string[];
}

export interface DisplayTheme {
  fg(color: string, text: string): string;
}

export interface DisplayContext {
  readonly showImages: boolean;
  readonly expanded: boolean;
  /** Per-row scratch space from the host, used to read each image only once. */
  readonly state: Record<string, unknown>;
}

interface DisplayImage {
  readonly path: string;
  readonly widthPx: number;
  readonly heightPx: number;
}

interface TuiModule {
  readonly getCapabilities: () => {
    readonly images: "kitty" | "iterm2" | null;
    readonly hyperlinks: boolean;
  };
  readonly hyperlink: (text: string, url: string) => string;
  readonly Text: new (text?: string, paddingX?: number, paddingY?: number) => Component;
  readonly Container: new () => Component & { addChild(child: Component): void };
  readonly Image: new (
    base64Data: string,
    mimeType: string,
    theme: { fallbackColor: (text: string) => string },
    options?: { maxWidthCells?: number; maxHeightCells?: number; filename?: string },
    dimensions?: { widthPx: number; heightPx: number },
  ) => Component;
}

let tui: TuiModule | undefined;
let tuiLoading: Promise<void> | undefined;

/** Uses the real host entry so executable symlinks resolve the host's TUI copy. */
export function tuiSpecifier(entry: string | undefined): string | undefined {
  if (entry === undefined) {
    return undefined;
  }
  try {
    const hostEntry = realpathSync(entry);
    return pathToFileURL(createRequire(hostEntry).resolve("@earendil-works/pi-tui")).href;
  } catch {
    return undefined;
  }
}

/** Resolves the host TUI and detects image support during extension startup. */
export function primeDisplay(): Promise<void> {
  if (tui !== undefined) {
    return Promise.resolve();
  }
  if (tuiLoading !== undefined) {
    return tuiLoading;
  }
  const specifier = tuiSpecifier(process.argv[1]);
  const loading = specifier === undefined ? import("@earendil-works/pi-tui") : import(specifier);
  tuiLoading = loading.then(
    (module) => {
      const candidate = parseTuiModule(module);
      if (candidate !== undefined && capabilities(candidate) !== undefined) {
        tui = candidate;
      } else {
        readCapabilities(module);
      }
    },
    () => {
      // Text rendering needs none of this, so a missing library is not worth reporting.
    },
  );
  return tuiLoading;
}

/** Whether the terminal speaks an image protocol, or `undefined` until the library has loaded. */
export function imagesSupported(): boolean | undefined {
  const supported = tui === undefined ? undefined : capabilities(tui);
  return supported === undefined ? undefined : supported.images !== null;
}

/** Whether this package can draw a result row at all, or the host has to print the text. */
export function displayLoaded(): boolean {
  return tui !== undefined;
}

/** Throws when the library is missing, which the host takes as a request to draw the row itself. */
function loadedModule(): TuiModule {
  if (tui === undefined) {
    primeDisplay();
    throw new Error("The TUI library is not loaded.");
  }
  return tui;
}

function parseTuiModule(value: unknown): TuiModule | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.getCapabilities === "function" &&
    typeof candidate.hyperlink === "function" &&
    typeof candidate.Text === "function" &&
    typeof candidate.Container === "function" &&
    typeof candidate.Image === "function"
    ? (candidate as unknown as TuiModule)
    : undefined;
}

function capabilities(
  module: TuiModule,
): { readonly images: "kitty" | "iterm2" | null; readonly hyperlinks: boolean } | undefined {
  return readCapabilities(module);
}

function readCapabilities(
  value: unknown,
): { readonly images: "kitty" | "iterm2" | null; readonly hyperlinks: boolean } | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const getCapabilities = (value as Record<string, unknown>).getCapabilities;
  if (typeof getCapabilities !== "function") {
    return undefined;
  }
  try {
    const found: unknown = getCapabilities();
    if (typeof found !== "object" || found === null) {
      return undefined;
    }
    const fields = found as Record<string, unknown>;
    const images = fields.images;
    const hyperlinks = fields.hyperlinks;
    return (images === "kitty" || images === "iterm2" || images === null) &&
      typeof hyperlinks === "boolean"
      ? { images, hyperlinks }
      : undefined;
  } catch {
    return undefined;
  }
}

export interface DiagramCallView {
  /** What is being drawn: the title, or a line count when there is no title. */
  readonly subject: string;
  /** The profile, and the directory when the call also saves files. */
  readonly note: string;
}

/** The row while D2 runs. The source would fill the transcript, so it is not shown. */
export function renderDiagramCall(view: DiagramCallView, theme: DisplayTheme): Component {
  const module = loadedModule();
  const text = [
    theme.fg("toolTitle", "diagram "),
    theme.fg("accent", view.subject),
    " ",
    theme.fg("muted", view.note),
  ].join("");
  return new module.Text(text, 0, 0);
}

export function renderDiagramResult(
  view: DiagramView,
  theme: DisplayTheme,
  context: DisplayContext,
): Component {
  const module = loadedModule();
  const container = new module.Container();
  const line = (text: string): void => {
    container.addChild(new module.Text(theme.fg("toolOutput", text), 0, 0));
  };
  const image = drawable(module, view.image, context) ? view.image : undefined;
  const url = image === undefined ? undefined : openable(module, image);
  if (view.title !== undefined) {
    line(url === undefined ? view.title : module.hyperlink(view.title, url));
  }

  if (image === undefined) {
    line(view.text);
  } else {
    try {
      container.addChild(
        new module.Image(
          read(image, context),
          "image/png",
          { fallbackColor: (text: string) => theme.fg("toolOutput", text) },
          {
            maxWidthCells: context.expanded ? UNBOUNDED_WIDTH_CELLS : PREVIEW_MAX_WIDTH_CELLS,
            maxHeightCells: context.expanded ? ZOOM_MAX_HEIGHT_CELLS : PREVIEW_MAX_HEIGHT_CELLS,
            filename: image.path,
          },
          { widthPx: image.widthPx, heightPx: image.heightPx },
        ),
      );
      if (view.title === undefined && url !== undefined) {
        const name = module.hyperlink(basename(image.path), url);
        container.addChild(new module.Text(theme.fg("muted", name), 0, 0));
      }
      container.addChild(
        new module.Text(
          theme.fg("muted", context.expanded ? "Ctrl+O: fit image" : "Ctrl+O: zoom image"),
          0,
          0,
        ),
      );
    } catch {
      // The picture is gone from the temp store, so show the text instead.
      line(view.text);
    }
  }

  const footer = [...view.notes, ...(context.expanded ? view.details : [])];
  if (footer.length > 0) {
    line(footer.join("\n"));
  }
  return container;
}

function openable(module: TuiModule, image: DisplayImage): string | undefined {
  return capabilities(module)?.hyperlinks === true && isSessionArtifactPath(image.path)
    ? pathToFileURL(image.path).href
    : undefined;
}

function drawable(
  module: TuiModule,
  image: DisplayImage | undefined,
  context: DisplayContext,
): boolean {
  const supported = capabilities(module);
  return (
    image !== undefined &&
    context.showImages &&
    isSessionArtifactPath(image.path) &&
    supported !== undefined &&
    supported.images !== null
  );
}

export interface DiagramView {
  readonly image: DisplayImage | undefined;
  readonly title: string | undefined;
  /** Drawn when there is no image, or when the one there is cannot be shown. */
  readonly text: string;
  readonly notes: readonly string[];
  /** Render mode, paths, diagnostics, and source. Shown only in the expanded row. */
  readonly details: readonly string[];
}

/** Reads the image once per result row: the host calls the renderer again on every redraw. */
function read(image: DisplayImage, context: DisplayContext): string {
  if (!isSessionArtifactPath(image.path)) {
    throw new Error("The image is not in this process's private store.");
  }
  const cached = context.state.diagramImage;
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
  const encoded = bytes.toString("base64");
  context.state.diagramImage = { path: image.path, encoded };
  return encoded;
}
