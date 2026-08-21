import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * Turns a diagram result into terminal components, choosing between the image and the text. The
 * image is read from the temp store at display time, which keeps encoded bytes out of the session.
 */

/** Wide enough for an architecture diagram, short enough to leave the transcript readable. */
const MAX_WIDTH_CELLS = 80;
/** Without a bound the library reserves a square, about 40 rows, drawn or not. */
const MAX_HEIGHT_CELLS = 30;
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
  readonly getCapabilities: () => { readonly images: "kitty" | "iterm2" | null };
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

/**
 * The library keeps image placement state in module scope, so the host and this package have to
 * use the same copy. A local checkout has its own, which wins by bare name.
 */
export function tuiSpecifier(entry: string | undefined): string {
  if (entry !== undefined) {
    try {
      return pathToFileURL(createRequire(entry).resolve("@earendil-works/pi-tui")).href;
    } catch {
      // Not resolvable from the host, so fall back to whatever this package can see.
    }
  }
  return "@earendil-works/pi-tui";
}

/** Loaded once at registration, since a render cannot wait on an import. */
export function primeDisplay(): Promise<void> {
  if (tui !== undefined) {
    return Promise.resolve();
  }
  return import(tuiSpecifier(process.argv[1])).then(
    (module) => {
      tui = module as unknown as TuiModule;
    },
    () => {
      // Text rendering needs none of this, so a missing library is not worth reporting.
    },
  );
}

/** Whether the terminal speaks an image protocol, or `undefined` until the library has loaded. */
export function imagesSupported(): boolean | undefined {
  return tui === undefined ? undefined : tui.getCapabilities().images !== null;
}

/** Throws when there is no image to show, which the host takes as a request to render text. */
export function renderDiagramImage(
  image: DiagramImageInput,
  theme: DisplayTheme,
  context: DisplayContext,
): Component {
  const module = tui;
  if (module === undefined) {
    primeDisplay();
    throw new Error("The TUI library is not loaded.");
  }
  if (!context.showImages) {
    throw new Error("Inline images are turned off.");
  }
  // The image component would otherwise draw a line naming the file, not the diagram.
  if (module.getCapabilities().images === null) {
    throw new Error("This terminal has no image protocol.");
  }

  const encoded = read(image.image, context);
  const container = new module.Container();
  if (image.title !== undefined) {
    container.addChild(new module.Text(theme.fg("toolOutput", image.title), 0, 0));
  }
  container.addChild(
    new module.Image(
      encoded,
      "image/png",
      { fallbackColor: (text: string) => theme.fg("toolOutput", text) },
      {
        maxWidthCells: MAX_WIDTH_CELLS,
        maxHeightCells: MAX_HEIGHT_CELLS,
        filename: image.image.path,
      },
      { widthPx: image.image.widthPx, heightPx: image.image.heightPx },
    ),
  );

  const footer = [...(context.expanded ? image.paths : []), ...image.notes];
  if (footer.length > 0) {
    container.addChild(new module.Text(theme.fg("toolOutput", footer.join("\n")), 0, 0));
  }
  return container;
}

export interface DiagramImageInput {
  readonly image: DisplayImage;
  readonly title: string | undefined;
  readonly paths: readonly string[];
  readonly notes: readonly string[];
}

/** Reads the image once per result row: the host calls the renderer again on every redraw. */
function read(image: DisplayImage, context: DisplayContext): string {
  const cached = context.state["diagramImage"];
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
  context.state["diagramImage"] = { path: image.path, encoded };
  return encoded;
}
