import { inflateSync } from "node:zlib";
import type { RenderedSvg } from "./runner.js";

/**
 * Recovers the fonts D2 embeds in its SVG. D2 sizes every box around the label it measured in
 * those faces, so drawing the image with any other font makes labels overflow.
 */

const MAX_FACES = 8;
const MAX_FACE_BYTES = 4 * 1024 * 1024;
const MAX_TABLES = 64;
/** A subset face covers a handful of glyphs; this only stops a malformed cmap looping. */
const MAX_COVERAGE = 65_536;

const FACE_BLOCK = /@font-face\s*\{([^}]*)\}/gu;
const FACE_FAMILY = /font-family:\s*([\w-]+)/u;
const FACE_WOFF = /url\(\s*["']?data:application\/font-woff;base64,([A-Za-z0-9+/=]+)/u;
const TEXT_ELEMENT = /<text\b[^>]*>([\s\S]*?)<\/text>/giu;
const INNER_TAG = /<[^>]*>/gu;

declare const sfntBrand: unique symbol;

/** A font rebuilt from a WOFF container, with a table directory this module checked. */
type SfntFont = Uint8Array & { readonly [sfntBrand]: true };

export interface EmbeddedFont {
  readonly family: string;
  readonly bytes: SfntFont;
  /** Code points the face can draw, or `undefined` when its cmap is not one this module reads. */
  readonly coverage: ReadonlySet<number> | undefined;
}

/**
 * Faces that could be rebuilt and understood. One that could not is left out rather than guessed
 * at, and reported through its missing coverage instead.
 */
export function parseEmbeddedFonts(svg: RenderedSvg): readonly EmbeddedFont[] {
  const fonts: EmbeddedFont[] = [];
  for (const block of svg.matchAll(FACE_BLOCK)) {
    if (fonts.length >= MAX_FACES) {
      break;
    }
    const declarations = block[1];
    if (declarations === undefined) {
      continue;
    }
    const family = FACE_FAMILY.exec(declarations)?.[1];
    const encoded = FACE_WOFF.exec(declarations)?.[1];
    if (family === undefined || encoded === undefined || encoded.length > MAX_FACE_BYTES) {
      continue;
    }
    try {
      const bytes = rebuild(Buffer.from(encoded, "base64"));
      fonts.push({ family, bytes, coverage: readCoverage(bytes) });
    } catch {
      // A face that cannot be rebuilt is left out rather than reported.
    }
  }
  return fonts;
}

/** Code points that have to be drawable, taken from the SVG's own text elements. */
export function textCodePoints(svg: RenderedSvg): ReadonlySet<number> {
  const needed = new Set<number>();
  for (const element of svg.matchAll(TEXT_ELEMENT)) {
    const content = element[1];
    if (content === undefined) {
      continue;
    }
    for (const char of decodeEntities(content.replace(INNER_TAG, ""))) {
      const code = char.codePointAt(0);
      // Whitespace needs no glyph, and a missing space would report a false gap on every label.
      if (code !== undefined && !/\s/u.test(char)) {
        needed.add(code);
      }
    }
  }
  return needed;
}

/** Code points no embedded face can draw. */
export function missingCodePoints(
  fonts: readonly EmbeddedFont[],
  needed: ReadonlySet<number>,
): readonly number[] {
  if (fonts.length === 0) {
    return [...needed];
  }
  if (fonts.some((font) => font.coverage === undefined)) {
    // One unreadable cmap makes the whole answer a guess, so nothing is claimed to be missing.
    return [];
  }
  return [...needed].filter((code) => !fonts.some((font) => font.coverage?.has(code) === true));
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (entity, body: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (body.startsWith("#")) {
      const code = Number.parseInt(
        body.slice(body.startsWith("#x") || body.startsWith("#X") ? 2 : 1),
        body.startsWith("#x") || body.startsWith("#X") ? 16 : 10,
      );
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    }
    return named[body.toLowerCase()] ?? entity;
  });
}

/** Every offset is checked against the buffer: the container is only as trustworthy as its SVG. */
function rebuild(woff: Buffer): SfntFont {
  if (woff.length < 44 || woff.toString("ascii", 0, 4) !== "wOFF") {
    throw new Error("Not a WOFF container.");
  }
  const numTables = woff.readUInt16BE(12);
  if (numTables === 0 || numTables > MAX_TABLES || 44 + numTables * 20 > woff.length) {
    throw new Error(`WOFF declares ${numTables} tables.`);
  }

  const tables: { tag: string; checksum: number; data: Buffer }[] = [];
  let decompressed = 0;
  for (let index = 0; index < numTables; index += 1) {
    const record = 44 + index * 20;
    const offset = woff.readUInt32BE(record + 4);
    const compressed = woff.readUInt32BE(record + 8);
    const original = woff.readUInt32BE(record + 12);
    decompressed += original;
    if (offset + compressed > woff.length || original > MAX_FACE_BYTES) {
      throw new Error("WOFF table lies outside the container.");
    }
    if (decompressed > MAX_FACE_BYTES) {
      throw new Error("WOFF tables decompress past the size limit.");
    }
    const raw = woff.subarray(offset, offset + compressed);
    const data = compressed === original ? raw : inflateSync(raw, { maxOutputLength: original });
    if (data.length !== original) {
      throw new Error("WOFF table does not decompress to its declared length.");
    }
    tables.push({
      tag: woff.toString("ascii", record, record + 4),
      checksum: woff.readUInt32BE(record + 16),
      data,
    });
  }
  tables.sort((left, right) => (left.tag < right.tag ? -1 : 1));

  const header = Buffer.alloc(12 + numTables * 16);
  header.writeUInt32BE(woff.readUInt32BE(4), 0);
  header.writeUInt16BE(numTables, 4);
  const highest = 2 ** Math.floor(Math.log2(numTables));
  header.writeUInt16BE(highest * 16, 6);
  header.writeUInt16BE(Math.log2(highest), 8);
  header.writeUInt16BE(numTables * 16 - highest * 16, 10);

  let position = header.length;
  const body: Buffer[] = [];
  tables.forEach((table, index) => {
    const record = 12 + index * 16;
    header.write(table.tag, record, 4, "ascii");
    header.writeUInt32BE(table.checksum, record + 4);
    header.writeUInt32BE(position, record + 8);
    header.writeUInt32BE(table.data.length, record + 12);
    const padding = (4 - (table.data.length % 4)) % 4;
    body.push(table.data, Buffer.alloc(padding));
    position += table.data.length + padding;
  });
  return Buffer.concat([header, ...body]) as unknown as SfntFont;
}

/** `undefined` when the face carries no cmap subtable in a format this module reads. */
function readCoverage(font: SfntFont): ReadonlySet<number> | undefined {
  const view = Buffer.from(font.buffer, font.byteOffset, font.byteLength);
  const cmap = findTable(view, "cmap");
  if (cmap === undefined || cmap + 4 > view.length) {
    return undefined;
  }

  const subtables = view.readUInt16BE(cmap + 2);
  let best: { format: number; offset: number } | undefined;
  for (let index = 0; index < subtables; index += 1) {
    const record = cmap + 4 + index * 8;
    if (record + 8 > view.length) {
      return undefined;
    }
    const offset = cmap + view.readUInt32BE(record + 4);
    if (offset + 2 > view.length) {
      return undefined;
    }
    const format = view.readUInt16BE(offset);
    // Format 12 reaches beyond the BMP, so it wins when a face offers both.
    if (format === 12 || (format === 4 && best === undefined)) {
      best = { format, offset };
    }
  }
  if (best === undefined) {
    return undefined;
  }
  return best.format === 12 ? readFormat12(view, best.offset) : readFormat4(view, best.offset);
}

function findTable(font: Buffer, tag: string): number | undefined {
  if (font.length < 12) {
    return undefined;
  }
  const numTables = font.readUInt16BE(4);
  if (12 + numTables * 16 > font.length) {
    return undefined;
  }
  for (let index = 0; index < numTables; index += 1) {
    const record = 12 + index * 16;
    if (font.toString("ascii", record, record + 4) === tag) {
      return font.readUInt32BE(record + 8);
    }
  }
  return undefined;
}

/** Windows BMP segment mapping, which is what D2's subset faces carry. */
function readFormat4(font: Buffer, offset: number): ReadonlySet<number> | undefined {
  if (offset + 14 > font.length) {
    return undefined;
  }
  const segments = font.readUInt16BE(offset + 6) / 2;
  const endCodes = offset + 14;
  const startCodes = endCodes + segments * 2 + 2;
  const deltas = startCodes + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  if (!Number.isSafeInteger(segments) || rangeOffsets + segments * 2 > font.length) {
    return undefined;
  }

  const covered = new Set<number>();
  for (let segment = 0; segment < segments; segment += 1) {
    const end = font.readUInt16BE(endCodes + segment * 2);
    const start = font.readUInt16BE(startCodes + segment * 2);
    const delta = font.readInt16BE(deltas + segment * 2);
    const rangeOffset = font.readUInt16BE(rangeOffsets + segment * 2);
    if (start > end || covered.size + (end - start) > MAX_COVERAGE) {
      return undefined;
    }
    for (let code = start; code <= end && code !== 0xffff; code += 1) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (code + delta) & 0xffff;
      } else {
        const at = rangeOffsets + segment * 2 + rangeOffset + (code - start) * 2;
        if (at + 2 > font.length) {
          return undefined;
        }
        const found = font.readUInt16BE(at);
        glyph = found === 0 ? 0 : (found + delta) & 0xffff;
      }
      if (glyph !== 0) {
        covered.add(code);
      }
    }
  }
  return covered;
}

function readFormat12(font: Buffer, offset: number): ReadonlySet<number> | undefined {
  if (offset + 16 > font.length) {
    return undefined;
  }
  const groups = font.readUInt32BE(offset + 12);
  if (offset + 16 + groups * 12 > font.length) {
    return undefined;
  }

  const covered = new Set<number>();
  for (let index = 0; index < groups; index += 1) {
    const record = offset + 16 + index * 12;
    const start = font.readUInt32BE(record);
    const end = font.readUInt32BE(record + 4);
    const glyph = font.readUInt32BE(record + 8);
    if (start > end || end > 0x10ffff || covered.size + (end - start) > MAX_COVERAGE) {
      return undefined;
    }
    if (glyph === 0) {
      continue;
    }
    for (let code = start; code <= end; code += 1) {
      covered.add(code);
    }
  }
  return covered;
}
