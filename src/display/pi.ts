import { basename } from "node:path";
import type {
  DiagramDisplay,
  DiagramResultView,
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
const fallbackStates = new WeakMap<object, Record<string, unknown>>();

interface PiContext {
  readonly showImages: boolean;
  readonly state: Record<string, unknown>;
}

export const piDisplay: DiagramDisplay<PiContext> = {
  resolveContext(key, _options, rawContext) {
    const record =
      typeof rawContext === "object" && rawContext !== null
        ? (rawContext as Record<string, unknown>)
        : undefined;
    const hostState = record?.state;
    let state =
      typeof hostState === "object" && hostState !== null
        ? (hostState as Record<string, unknown>)
        : fallbackStates.get(key);
    if (state === undefined) {
      state = {};
      fallbackStates.set(key, state);
    }
    return {
      showImages: typeof record?.showImages === "boolean" ? record.showImages : true,
      state,
    };
  },

  renderCall,

  renderResult(view, options, theme, context) {
    return renderPiResult(view, options, theme, context);
  },
};

function renderPiResult(
  view: DiagramResultView,
  options: RenderOptions,
  theme: DisplayTheme,
  context: PiContext,
): StackComponent {
  const wantsImage = view.requested === "image" || (view.requested === "auto" && options.expanded);
  const canShowImage =
    wantsImage && view.image !== undefined && context.showImages && imagesSupported() === true;
  const picture =
    canShowImage && view.image !== undefined
      ? createImage(
          view.image,
          theme,
          context.state,
          options.expanded
            ? {
                maxWidthCells: UNBOUNDED_WIDTH_CELLS,
                maxHeightCells: UNBOUNDED_WIDTH_CELLS,
                filename: view.image.path,
              }
            : {
                maxWidthCells: PREVIEW_MAX_WIDTH_CELLS,
                maxHeightCells: PREVIEW_MAX_HEIGHT_CELLS,
                filename: view.image.path,
              },
        )
      : undefined;
  const warning =
    wantsImage && view.image !== undefined && !canShowImage
      ? context.showImages
        ? IMAGE_UNAVAILABLE_WARNING
        : "Inline images are disabled in this view."
      : undefined;
  const notes =
    warning === undefined || view.notes.includes(warning) ? view.notes : [...view.notes, warning];
  const hint = piHint(view, options, picture !== undefined);
  const container = new StackComponent();
  const line = (text: string): void => {
    container.addChild(new TextComponent(theme.fg("toolOutput", text)));
  };
  const muted = (text: string): void => {
    container.addChild(new TextComponent(theme.fg("muted", text)));
  };
  const url = picture !== undefined && view.image !== undefined ? imageUrl(view.image) : undefined;

  if (view.title !== undefined) {
    line(url === undefined ? view.title : hyperlink(view.title, url));
  }
  if (picture === undefined) {
    line(view.text);
    if (hint !== undefined && !wantsImage) {
      muted(hint);
    }
  } else {
    container.addChild(picture);
    if (view.title === undefined && url !== undefined && view.image !== undefined) {
      muted(hyperlink(basename(view.image.path), url));
    }
    if (hint !== undefined) {
      muted(hint);
    }
  }

  const footer = [
    ...notes,
    ...(options.expanded ? view.details(picture === undefined ? view.renderedAs : "image") : []),
  ];
  if (footer.length > 0) {
    line(footer.join("\n"));
  }
  return container;
}

function piHint(
  view: DiagramResultView,
  options: RenderOptions,
  imageShown: boolean,
): string | undefined {
  if (view.requested === "auto" && !options.expanded && view.image !== undefined) {
    return "Ctrl+O: view PNG";
  }
  if (view.requested === "auto" && options.expanded && imageShown) {
    return "Ctrl+O: show Unicode";
  }
  if (view.requested === "image" && imageShown) {
    return options.expanded ? "Ctrl+O: fit image" : "Ctrl+O: zoom image";
  }
  return undefined;
}
