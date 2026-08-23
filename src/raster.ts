import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKeyOf, FileCache, type RenderCache } from "./cache.js";
import {
  type EmbeddedFont,
  missingCodePoints,
  parseEmbeddedFonts,
  textCodePoints,
} from "./d2/fonts.js";
import type { RenderedSvg } from "./d2/runner.js";
import { CommandCancelledError, throwIfCancelled } from "./process.js";
import { errorMessage } from "./unknown.js";

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
const MAX_PIXELS = MAX_WIDTH_PX * MAX_HEIGHT_PX;
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

export interface RasterDimensions {
  readonly widthPx: number;
  readonly heightPx: number;
}

/** resvg reporting success is not proof the bytes are a usable PNG of the size asked for. */
export function parseRenderedPng(bytes: Uint8Array, expected: RasterDimensions): RasterImage {
  if (bytes.length > MAX_PNG_BYTES) {
    throw new ImageRenderUnavailableError(
      `The image is ${bytes.length} bytes, past the ${MAX_PNG_BYTES} byte limit.`,
    );
  }
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new ImageRenderUnavailableError("The renderer did not return a PNG.");
  }

  let offset = PNG_SIGNATURE.length;
  let chunks = 0;
  let sawData = false;
  let widthPx: number | undefined;
  let heightPx: number | undefined;
  while (offset < buffer.length) {
    if (buffer.length - offset < 12) {
      throw new ImageRenderUnavailableError("The PNG is truncated.");
    }
    const length = buffer.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const next = dataEnd + 4;
    if (dataEnd < dataStart || next < dataEnd || next > buffer.length) {
      throw new ImageRenderUnavailableError("The PNG contains a truncated chunk.");
    }
    const type = buffer.toString("ascii", offset + 4, dataStart);
    if (!/^[A-Za-z]{4}$/u.test(type)) {
      throw new ImageRenderUnavailableError("The PNG contains an invalid chunk type.");
    }
    if (buffer.readUInt32BE(dataEnd) !== crc32(buffer, offset + 4, dataEnd)) {
      throw new ImageRenderUnavailableError("The PNG contains a corrupt chunk.");
    }
    if (chunks === 0) {
      if (type !== "IHDR" || length !== 13) {
        throw new ImageRenderUnavailableError("The PNG does not start with an image header.");
      }
      widthPx = buffer.readUInt32BE(dataStart);
      heightPx = buffer.readUInt32BE(dataStart + 4);
    } else if (type === "IHDR") {
      throw new ImageRenderUnavailableError("The PNG contains more than one image header.");
    }
    if (type === "IDAT") {
      sawData = true;
    }
    if (type === "IEND") {
      if (length !== 0 || !sawData || next !== buffer.length) {
        throw new ImageRenderUnavailableError("The PNG is incomplete.");
      }
      break;
    }
    chunks += 1;
    offset = next;
  }
  if (widthPx === undefined || heightPx === undefined || offset >= buffer.length) {
    throw new ImageRenderUnavailableError("The PNG is truncated.");
  }
  if (
    widthPx === 0 ||
    heightPx === 0 ||
    widthPx > MAX_WIDTH_PX ||
    heightPx > MAX_HEIGHT_PX ||
    widthPx * heightPx > MAX_PIXELS
  ) {
    throw new ImageRenderUnavailableError("The PNG has unsafe dimensions.");
  }
  if (Math.abs(widthPx - expected.widthPx) > 1 || Math.abs(heightPx - expected.heightPx) > 1) {
    throw new ImageRenderUnavailableError(
      `The PNG is ${widthPx} by ${heightPx} pixels, not the ${expected.widthPx} by ${expected.heightPx} that were asked for.`,
    );
  }
  return { png: bytes as RenderedPng, widthPx, heightPx, systemFonts: false };
}

/** PNG checksums cover each chunk type and its data, never its length or CRC field. */
function crc32(bytes: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index] as number;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
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
      `The SVG rasterizer could not be loaded: ${errorMessage(error)}`,
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
      `The SVG could not be drawn as an image: ${errorMessage(error)}`,
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
