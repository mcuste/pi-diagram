import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommandCancelledError,
  cacheKeyOf,
  FileCache,
  ImageRenderUnavailableError,
  MAX_HEIGHT_PX,
  MAX_PIXELS,
  MAX_WIDTH_PX,
  parseRenderedPng,
  type RasterDimensions,
  type RasterImage,
  type RenderCache,
  safeErrorMessage,
  throwIfCancelled,
} from "@mcuste/pi-diagram-core";
import {
  type EmbeddedFont,
  missingCodePoints,
  parseEmbeddedFonts,
  textCodePoints,
} from "./fonts.js";
import type { RenderedSvg } from "./runner.js";

/**
 * Draws a D2 SVG as a PNG. D2's own PNG export drives a headless browser it downloads on first
 * use; resvg needs no browser and no network.
 */

/** Twice the natural size keeps labels readable once the terminal scales the image to cells. */
const SCALE = 2;
const MIN_WIDTH_PX = 480;
const DEFAULT_FONT_FAMILY = "Source Sans Pro";

/** Everything besides the SVG and resvg itself that decides the picture. */
const IMAGE_POLICY = [
  "png",
  String(SCALE),
  String(MIN_WIDTH_PX),
  String(MAX_WIDTH_PX),
  String(MAX_HEIGHT_PX),
  DEFAULT_FONT_FAMILY,
];

export interface RasterRequest {
  readonly svg: RenderedSvg;
  readonly signal: AbortSignal | undefined;
}

export interface SvgRasterizer {
  rasterize(request: RasterRequest): Promise<RasterImage>;
}

/** Bounds the raster canvas before resvg allocates it. */
export function parseTargetDimensions(
  naturalWidthPx: number,
  naturalHeightPx: number,
): RasterDimensions {
  if (
    !Number.isFinite(naturalWidthPx) ||
    !Number.isFinite(naturalHeightPx) ||
    naturalWidthPx < 1 ||
    naturalHeightPx < 1
  ) {
    throw new ImageRenderUnavailableError(
      `The SVG reports a ${naturalWidthPx} by ${naturalHeightPx} canvas.`,
    );
  }

  const maximumScale = Math.min(MAX_WIDTH_PX / naturalWidthPx, MAX_HEIGHT_PX / naturalHeightPx);
  const scale = Math.min(maximumScale, Math.max(SCALE, MIN_WIDTH_PX / naturalWidthPx));
  const widthPx = Math.floor(naturalWidthPx * scale);
  const heightPx = Math.floor(naturalHeightPx * scale);
  if (
    !Number.isSafeInteger(widthPx) ||
    !Number.isSafeInteger(heightPx) ||
    widthPx < 1 ||
    heightPx < 1 ||
    widthPx > MAX_WIDTH_PX ||
    heightPx > MAX_HEIGHT_PX ||
    widthPx * heightPx > MAX_PIXELS
  ) {
    throw new ImageRenderUnavailableError(
      `The SVG aspect ratio cannot fit within ${MAX_WIDTH_PX} by ${MAX_HEIGHT_PX} pixels.`,
    );
  }
  return { widthPx, heightPx };
}

export function parseTargetWidth(naturalWidthPx: number, naturalHeightPx: number): number {
  return parseTargetDimensions(naturalWidthPx, naturalHeightPx).widthPx;
}

/** The store holds text, so an image travels as base64 behind the sizes it was drawn at. */
function formatCachedImage(image: RasterImage): string {
  const drawn = `${image.widthPx} ${image.heightPx} ${image.systemFonts ? 1 : 0}`;
  return `${drawn}\n${Buffer.from(image.png).toString("base64")}`;
}

/** Parsed again on the way out, so a corrupt entry is drawn again rather than displayed. */
export function parseCachedImage(entry: string): RasterImage {
  const split = entry.indexOf("\n");
  const [width, height, fonts] = entry.slice(0, Math.max(split, 0)).split(" ");
  const widthPx = Number(width);
  const heightPx = Number(height);
  const sized =
    Number.isSafeInteger(widthPx) && widthPx > 0 && Number.isSafeInteger(heightPx) && heightPx > 0;
  if (split === -1 || !sized || (fonts !== "0" && fonts !== "1")) {
    throw new ImageRenderUnavailableError("The stored image does not say how it was drawn.");
  }

  const image = parseRenderedPng(Buffer.from(entry.slice(split + 1), "base64"), {
    widthPx,
    heightPx,
  });
  if (image.widthPx !== widthPx || image.heightPx !== heightPx) {
    throw new ImageRenderUnavailableError(
      `The stored image is ${image.widthPx} by ${image.heightPx} pixels, not the ${widthPx} by ${heightPx} it was drawn at.`,
    );
  }
  return { ...image, systemFonts: fonts === "1" };
}

type ResvgModule = typeof import("@resvg/resvg-js");

let loaded: Promise<ResvgModule> | undefined;
let installed: Promise<string | undefined> | undefined;

/** A native binary per platform, loaded lazily so an unsupported one cannot break text diagrams. */
async function load(): Promise<ResvgModule> {
  loaded ??= import("@resvg/resvg-js");
  try {
    return await loaded;
  } catch (error) {
    loaded = undefined;
    throw new ImageRenderUnavailableError(
      `The SVG rasterizer could not be loaded: ${safeErrorMessage(error)}`,
      { cause: error },
    );
  }
}

export class ResvgRasterizer implements SvgRasterizer {
  private readonly cache: RenderCache;

  constructor(dependencies: { readonly cache?: RenderCache } = {}) {
    this.cache = dependencies.cache ?? new FileCache();
  }

  async rasterize(request: RasterRequest): Promise<RasterImage> {
    throwIfCancelled(request.signal, "Drawing the diagram");

    const key = await imageKey(request.svg);
    const stored = key === undefined ? undefined : await this.cache.read(key);
    if (stored !== undefined) {
      let cached: RasterImage | undefined;
      try {
        cached = parseCachedImage(stored);
      } catch {
        // An entry this build cannot read is no better than a missing one.
      }
      if (cached !== undefined) {
        throwIfCancelled(request.signal, "Drawing the diagram");
        return cached;
      }
    }

    const image = await draw(request.svg, request.signal);
    throwIfCancelled(request.signal, "Drawing the diagram");
    if (key !== undefined) {
      await this.cache.write(key, formatCachedImage(image));
    }
    return image;
  }
}

/** Undefined when the version is unknown, which keeps that image out of the store. */
async function imageKey(svg: RenderedSvg): Promise<string | undefined> {
  const version = await resvgVersion();
  return version === undefined ? undefined : cacheKeyOf([...IMAGE_POLICY, version, svg]);
}

/** resvg draws differently between versions, so a stored image belongs to the one that drew it. */
async function resvgVersion(): Promise<string | undefined> {
  installed ??= (async (): Promise<string | undefined> => {
    try {
      const manifest = createRequire(import.meta.url).resolve("@resvg/resvg-js/package.json");
      const parsed: unknown = JSON.parse(await readFile(manifest, "utf8"));
      if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
        return undefined;
      }
      return typeof parsed.version === "string" ? parsed.version : undefined;
    } catch {
      return undefined;
    }
  })();
  return installed;
}
async function draw(svg: RenderedSvg, signal: AbortSignal | undefined): Promise<RasterImage> {
  throwIfCancelled(signal, "Drawing the diagram");
  const { Resvg } = await load();
  const fonts = parseEmbeddedFonts(svg);
  const missing = missingCodePoints(fonts, textCodePoints(svg));
  const directory = await mkdtemp(join(tmpdir(), "pi-diagram-fonts-"));
  try {
    const fontFiles = await writeFonts(directory, fonts);
    throwIfCancelled(signal, "Drawing the diagram");
    const font = {
      fontFiles,
      // Labels the diagram's own font cannot draw would otherwise be empty boxes.
      loadSystemFonts: missing.length > 0,
      defaultFontFamily: DEFAULT_FONT_FAMILY,
    };

    const probe = new Resvg(svg, { font });
    const dimensions = parseTargetDimensions(probe.width, probe.height);
    const fitTo =
      dimensions.heightPx === MAX_HEIGHT_PX && dimensions.widthPx < MAX_WIDTH_PX
        ? { mode: "height" as const, value: dimensions.heightPx }
        : { mode: "width" as const, value: dimensions.widthPx };
    const drawn = new Resvg(svg, { font, fitTo });
    const image = parseRenderedPng(drawn.render().asPng(), dimensions);
    throwIfCancelled(signal, "Drawing the diagram");
    return { ...image, systemFonts: missing.length > 0 };
  } catch (error) {
    if (error instanceof ImageRenderUnavailableError || error instanceof CommandCancelledError) {
      throw error;
    }
    throw new ImageRenderUnavailableError(
      `The SVG could not be drawn as an image: ${safeErrorMessage(error)}`,
      { cause: error },
    );
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeFonts(directory: string, fonts: readonly EmbeddedFont[]): Promise<string[]> {
  const paths: string[] = [];
  for (const [index, font] of fonts.entries()) {
    const path = join(directory, `face-${index}.ttf`);
    await writeFile(path, font.bytes, { mode: 0o600 });
    paths.push(path);
  }
  return paths;
}
