import { basename } from "node:path";
import { isRecord } from "@mcuste/pi-diagram-core";
import type {
  Component,
  DiagramDisplay,
  DiagramResultView,
  DisplayImage,
  DisplayTheme,
  RenderOptions,
} from "./contracts.js";
import {
  appendWarning,
  createImage,
  createPreviewImage,
  fallbackState,
  hyperlink,
  IMAGE_UNAVAILABLE_WARNING,
  imagesSupported,
  imageUrl,
  ResultComponent,
  renderCall,
  UNBOUNDED_WIDTH_CELLS,
} from "./shared.js";

interface PiContext {
  readonly showImages: boolean;
  readonly state: Record<string, unknown>;
}

export const piDisplay: DiagramDisplay<PiContext> = {
  resolveContext(key, _options, rawContext) {
    const record = isRecord(rawContext) ? rawContext : undefined;
    const hostState = record?.state;
    return {
      showImages: typeof record?.showImages === "boolean" ? record.showImages : true,
      state: isRecord(hostState) ? hostState : fallbackState(key),
    };
  },

  renderCall,

  renderResult: renderPiResult,
};

function renderPiResult(
  view: DiagramResultView,
  options: RenderOptions,
  theme: DisplayTheme,
  context: PiContext,
): ResultComponent {
  const wantsImage = view.requested === "image" || (view.requested === "auto" && options.expanded);
  const canShowImage =
    wantsImage && view.image !== undefined && context.showImages && imagesSupported() === true;
  const picture =
    canShowImage && view.image !== undefined
      ? drawImage(view.image, theme, context.state, options.expanded)
      : undefined;
  const warning =
    wantsImage && view.image !== undefined && !canShowImage
      ? context.showImages
        ? IMAGE_UNAVAILABLE_WARNING
        : "Inline images are disabled in this view."
      : undefined;
  const notes = appendWarning(view.notes, warning);
  const hint = piHint(view, options, picture !== undefined);
  const container = new ResultComponent(theme);
  const url = picture !== undefined && view.image !== undefined ? imageUrl(view.image) : undefined;

  if (view.title !== undefined) {
    container.line(url === undefined ? view.title : hyperlink(view.title, url));
  }
  if (picture === undefined) {
    container.line(view.display.content);
    if (hint !== undefined && !wantsImage) {
      container.muted(hint);
    }
  } else {
    container.addChild(picture);
    if (view.title === undefined && url !== undefined && view.image !== undefined) {
      container.muted(hyperlink(basename(view.image.path), url));
    }
    if (hint !== undefined) {
      container.muted(hint);
    }
  }

  const footer = [
    ...notes,
    ...(options.expanded
      ? view.details(picture === undefined ? view.display.format : "image")
      : []),
  ];
  if (footer.length > 0) {
    container.line(footer.join("\n"));
  }
  return container;
}

/** Expanded fills the terminal; collapsed keeps the row short. */
function drawImage(
  image: DisplayImage,
  theme: DisplayTheme,
  state: Record<string, unknown>,
  expanded: boolean,
): Component | undefined {
  return expanded
    ? createImage(image, theme, state, {
        maxWidthCells: UNBOUNDED_WIDTH_CELLS,
        maxHeightCells: UNBOUNDED_WIDTH_CELLS,
        filename: image.path,
      })
    : createPreviewImage(image, theme, state);
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
