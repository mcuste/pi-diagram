/** Parses PNG bytes before they are stored, displayed, or written into the workspace. */

export const MAX_WIDTH_PX = 1600;
export const MAX_HEIGHT_PX = 2400;
export const MAX_PIXELS = MAX_WIDTH_PX * MAX_HEIGHT_PX;
const MAX_PNG_BYTES = 4 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

declare const renderedPngBrand: unique symbol;

/** Bytes that passed `parseRenderedPng`, so they really are a PNG of a known size. */
type RenderedPng = Uint8Array & { readonly [renderedPngBrand]: true };

export interface RasterImage {
  readonly png: RenderedPng;
  readonly widthPx: number;
  readonly heightPx: number;
  /** True when the diagram's own font could not draw every label, so system fonts were added. */
  readonly systemFonts: boolean;
}

/** A validated PNG persisted in the private session store. */
export interface StoredPng {
  readonly path: string;
  readonly widthPx: number;
  readonly heightPx: number;
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
