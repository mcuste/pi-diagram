import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EmbeddedFont,
  missingCodePoints,
  parseEmbeddedFonts,
  textCodePoints,
} from "./d2/fonts.js";
import type { RenderedSvg } from "./d2/runner.js";
import { CommandCancelledError } from "./process.js";

/**
 * Draws a D2 SVG as a PNG. D2's own PNG export drives a headless browser it downloads on first
 * use; resvg needs no browser and no network.
 */

/** Twice the natural size keeps labels readable once the terminal scales the image to cells. */
const SCALE = 2;
const MIN_WIDTH_PX = 480;
const MAX_WIDTH_PX = 1600;
const MAX_HEIGHT_PX = 2400;
const MAX_PNG_BYTES = 4 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

declare const renderedPngBrand: unique symbol;

/** Bytes that passed `parseRenderedPng`, so they really are a PNG of a known size. */
type RenderedPng = Uint8Array & { readonly [renderedPngBrand]: true };

export interface RasterRequest {
  readonly svg: RenderedSvg;
  readonly signal: AbortSignal | undefined;
}

export interface RasterImage {
  readonly png: RenderedPng;
  readonly widthPx: number;
  readonly heightPx: number;
  /** True when the diagram's own font could not draw every label, so system fonts were added. */
  readonly systemFonts: boolean;
}

export interface SvgRasterizer {
  rasterize(request: RasterRequest): Promise<RasterImage>;
}

/** The diagram is fine and only the image failed, so the caller shows text rather than failing. */
export class ImageRenderUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImageRenderUnavailableError";
  }
}

/** resvg reporting success is not proof the bytes are a usable PNG of the size asked for. */
export function parseRenderedPng(bytes: Uint8Array, expectedWidthPx: number): RasterImage {
  if (bytes.length > MAX_PNG_BYTES) {
    throw new ImageRenderUnavailableError(
      `The image is ${bytes.length} bytes, past the ${MAX_PNG_BYTES} byte limit.`,
    );
  }
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new ImageRenderUnavailableError("The renderer did not return a PNG.");
  }
  if (buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new ImageRenderUnavailableError("The PNG does not start with an image header.");
  }
  if (buffer.toString("ascii", buffer.length - 8, buffer.length - 4) !== "IEND") {
    throw new ImageRenderUnavailableError("The PNG is truncated.");
  }

  const widthPx = buffer.readUInt32BE(16);
  const heightPx = buffer.readUInt32BE(20);
  if (widthPx === 0 || heightPx === 0) {
    throw new ImageRenderUnavailableError("The PNG has no area.");
  }
  // A silently ignored size option would otherwise reach the terminal as an unreadable image.
  if (Math.abs(widthPx - expectedWidthPx) > 1) {
    throw new ImageRenderUnavailableError(
      `The PNG is ${widthPx} pixels wide, not the ${expectedWidthPx} that were asked for.`,
    );
  }
  return { png: bytes as RenderedPng, widthPx, heightPx, systemFonts: false };
}

/** Enough resolution to scale down cleanly, never a pathological canvas. */
export function parseTargetWidth(naturalWidthPx: number, naturalHeightPx: number): number {
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

  // The limits come last, so a tall diagram is drawn smaller rather than past the canvas bound.
  const byHeight = (MAX_HEIGHT_PX / naturalHeightPx) * naturalWidthPx;
  const wanted = Math.max(naturalWidthPx * SCALE, MIN_WIDTH_PX);
  return Math.max(1, Math.round(Math.min(wanted, MAX_WIDTH_PX, byHeight)));
}

type ResvgModule = typeof import("@resvg/resvg-js");

let loaded: Promise<ResvgModule> | undefined;

/** A native binary per platform, loaded lazily so an unsupported one cannot break text diagrams. */
async function load(): Promise<ResvgModule> {
  loaded ??= import("@resvg/resvg-js");
  try {
    return await loaded;
  } catch (error) {
    loaded = undefined;
    throw new ImageRenderUnavailableError(
      `The SVG rasterizer could not be loaded: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

export class ResvgRasterizer implements SvgRasterizer {
  async rasterize(request: RasterRequest): Promise<RasterImage> {
    if (request.signal?.aborted === true) {
      throw new CommandCancelledError("Drawing the diagram");
    }

    const { Resvg } = await load();
    const fonts = parseEmbeddedFonts(request.svg);
    const missing = missingCodePoints(fonts, textCodePoints(request.svg));
    const directory = await mkdtemp(join(tmpdir(), "pi-diagram-fonts-"));
    try {
      const fontFiles = await writeFonts(directory, fonts);
      const font = {
        fontFiles,
        // Labels the diagram's own font cannot draw would otherwise be empty boxes.
        loadSystemFonts: missing.length > 0,
        defaultFontFamily: "Source Sans Pro",
      };

      const probe = new Resvg(request.svg, { font });
      const widthPx = parseTargetWidth(probe.width, probe.height);
      const drawn = new Resvg(request.svg, { font, fitTo: { mode: "width", value: widthPx } });
      const image = parseRenderedPng(drawn.render().asPng(), widthPx);
      return { ...image, systemFonts: missing.length > 0 };
    } catch (error) {
      if (error instanceof ImageRenderUnavailableError || error instanceof CommandCancelledError) {
        throw error;
      }
      throw new ImageRenderUnavailableError(
        `The SVG could not be drawn as an image: ${(error as Error).message}`,
        { cause: error },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
