import { basename } from "node:path";
import type {
  Component,
  DiagramDisplay,
  DiagramResultView,
  DisplayImage,
  DisplayTheme,
  RenderOptions,
} from "./contracts.js";
import {
  createImage,
  hyperlink,
  imagesSupported,
  imageUrl,
  PREVIEW_MAX_HEIGHT_CELLS,
  PREVIEW_MAX_WIDTH_CELLS,
  renderCall,
  StackComponent,
  TextComponent,
  UNBOUNDED_WIDTH_CELLS,
} from "./shared.js";

const IMAGE_UNAVAILABLE_WARNING = "This terminal cannot display inline images.";
const WIDGET_KEY = "pi-diagram.png";
const fallbackStates = new WeakMap<object, Record<string, unknown>>();
const toggleStates = new WeakMap<OmpUi, ToggleState>();

interface OmpContext {
  readonly state: Record<string, unknown>;
}

interface OmpOverlayTui {
  readonly terminal?: { readonly rows?: number };
  readonly imageBudget?: unknown;
}

interface OmpKeybindings {
  matches(data: string, action: string): boolean;
}

type OverlayFactory = (
  tui: OmpOverlayTui,
  theme: DisplayTheme,
  keybindings: OmpKeybindings,
  done: (result: undefined) => void,
) => Component;

interface OmpUi {
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
  custom(
    factory: OverlayFactory,
    options: {
      overlay: true;
      overlayOptions: {
        fullscreen: true;
        width: "100%";
        maxHeight: "100%";
        margin: 0;
      };
    },
  ): Promise<undefined>;
}

interface OmpToolContext {
  readonly ui: OmpUi;
  setInterval(callback: () => void, milliseconds: number): unknown;
}

interface OmpOverlayView {
  readonly image: DisplayImage | undefined;
  readonly title: string | undefined;
}

interface ToggleState {
  view: OmpOverlayView | undefined;
  overlayOpen: boolean;
}

export function updateOmpDiagramOverlay(
  rawContext: unknown,
  view: OmpOverlayView,
  enabled: boolean,
): void {
  if (!isOmpToolContext(rawContext)) {
    return;
  }
  const { ui } = rawContext;
  let state = toggleStates.get(ui);
  if (state === undefined) {
    state = { view: undefined, overlayOpen: false };
    toggleStates.set(ui, state);
    rawContext.setInterval(() => syncDiagramOverlay(ui, state as ToggleState), 75);
  }
  state.view = enabled ? view : undefined;
  syncDiagramOverlay(ui, state);
}

function isOmpToolContext(value: unknown): value is OmpToolContext {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const ui = Reflect.get(value, "ui");
  return (
    typeof Reflect.get(value, "setInterval") === "function" &&
    typeof ui === "object" &&
    ui !== null &&
    typeof Reflect.get(ui, "getToolsExpanded") === "function" &&
    typeof Reflect.get(ui, "setToolsExpanded") === "function" &&
    typeof Reflect.get(ui, "custom") === "function"
  );
}

function syncDiagramOverlay(ui: OmpUi, state: ToggleState): void {
  const view = state.view;
  if (state.overlayOpen || view?.image === undefined || !ui.getToolsExpanded()) {
    return;
  }
  state.overlayOpen = true;
  const imageState: Record<string, unknown> = {};
  const finish = (): void => {
    ui.setToolsExpanded(false);
    state.overlayOpen = false;
  };
  void ui
    .custom(
      (tui, theme, keybindings, done) =>
        renderPngOverlay(
          view.image as DisplayImage,
          view.title,
          imageState,
          tui,
          theme,
          keybindings,
          done,
        ),
      {
        overlay: true,
        overlayOptions: {
          fullscreen: true,
          width: "100%",
          maxHeight: "100%",
          margin: 0,
        },
      },
    )
    .then(finish, finish);
}

class OmpPngOverlay implements Component {
  private closed = false;

  constructor(
    private readonly content: Component,
    private readonly keybindings: OmpKeybindings,
    private readonly done: (result: undefined) => void,
  ) {}

  render(width: number): string[] {
    return this.content.render(width);
  }

  handleInput(data: string): void {
    if (
      !this.closed &&
      (this.keybindings.matches(data, "app.tools.expand") || data === "\x0f" || data === "\x1b")
    ) {
      this.closed = true;
      this.done(undefined);
    }
  }
}

function renderPngOverlay(
  image: DisplayImage,
  title: string | undefined,
  state: Record<string, unknown>,
  tui: OmpOverlayTui,
  theme: DisplayTheme,
  keybindings: OmpKeybindings,
  done: (result: undefined) => void,
): Component {
  const rows = tui.terminal?.rows;
  const maxHeightCells =
    typeof rows === "number" && Number.isFinite(rows)
      ? Math.max(4, Math.trunc(rows) - 3)
      : PREVIEW_MAX_HEIGHT_CELLS;
  const container = new StackComponent();
  container.addChild(
    new TextComponent(theme.fg("muted", `${title ?? "PNG preview"} · Ctrl+O or Esc to close`)),
  );
  const picture = createImage(image, theme, state, {
    maxWidthCells: UNBOUNDED_WIDTH_CELLS,
    maxHeightCells,
    filename: image.path,
    budget: tui.imageBudget,
    imageKey: `${WIDGET_KEY}:${image.path}`,
  });
  container.addChild(
    picture ?? new TextComponent(theme.fg("muted", "This terminal cannot display inline images.")),
  );
  return new OmpPngOverlay(container, keybindings, done);
}

export function isOmpRenderContext(rawContext: unknown): boolean {
  return (
    typeof rawContext === "object" &&
    rawContext !== null &&
    typeof Reflect.get(rawContext, "source") === "string"
  );
}

export const ompDisplay: DiagramDisplay<OmpContext> = {
  resolveContext(key) {
    let state = fallbackStates.get(key);
    if (state === undefined) {
      state = {};
      fallbackStates.set(key, state);
    }
    return { state };
  },

  renderCall,

  renderResult(view, options, theme, context) {
    return renderOmpResult(view, options, theme, context);
  },
};

function renderOmpResult(
  view: DiagramResultView,
  _options: RenderOptions,
  theme: DisplayTheme,
  context: OmpContext,
): StackComponent {
  const wantsImage = view.requested === "image";
  const canShowImage = wantsImage && view.image !== undefined && imagesSupported() === true;
  const picture =
    canShowImage && view.image !== undefined
      ? createImage(view.image, theme, context.state, {
          maxWidthCells: PREVIEW_MAX_WIDTH_CELLS,
          maxHeightCells: PREVIEW_MAX_HEIGHT_CELLS,
          filename: view.image.path,
        })
      : undefined;
  const warning =
    wantsImage && view.image !== undefined && !canShowImage ? IMAGE_UNAVAILABLE_WARNING : undefined;
  const notes =
    warning === undefined || view.notes.includes(warning) ? view.notes : [...view.notes, warning];
  const container = new StackComponent();
  const line = (text: string): void => {
    container.addChild(new TextComponent(theme.fg("toolOutput", text)));
  };
  const muted = (text: string): void => {
    container.addChild(new TextComponent(theme.fg("muted", text)));
  };
  const url = view.image === undefined ? undefined : imageUrl(view.image);

  if (view.title !== undefined) {
    line(view.title);
  }

  if (view.requested === "auto") {
    line(view.display.content);
    if (url !== undefined && view.image !== undefined) {
      muted(`Open PNG: ${hyperlink(basename(view.image.path), url)}`);
    }
    if (view.image !== undefined) {
      muted("Ctrl+O: view latest PNG");
    }
    if (notes.length > 0) {
      line(notes.join("\n"));
    }
    return container;
  }

  if (picture === undefined) {
    line(view.display.content);
  } else {
    container.addChild(picture);
  }
  if (url !== undefined && view.image !== undefined) {
    muted(`Open PNG: ${hyperlink(basename(view.image.path), url)}`);
  }
  if (notes.length > 0) {
    line(notes.join("\n"));
  }
  return container;
}
