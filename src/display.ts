import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * Turns a diagram result into terminal components. Both the image and the text are drawn here
 * rather than by the host, so neither has to travel back through the model's context. The image is
 * read from the temp store at display time.
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
  if (view.title !== undefined) {
    line(view.title);
  }

  const image = drawable(module, view.image, context) ? view.image : undefined;
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
            maxWidthCells: MAX_WIDTH_CELLS,
            maxHeightCells: MAX_HEIGHT_CELLS,
            filename: image.path,
          },
          { widthPx: image.widthPx, heightPx: image.heightPx },
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

function drawable(
  module: TuiModule,
  image: DisplayImage | undefined,
  context: DisplayContext,
): boolean {
  return image !== undefined && context.showImages && module.getCapabilities().images !== null;
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
