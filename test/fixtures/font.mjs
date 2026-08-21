import { deflateSync } from "node:zlib";

/**
 * Builds a WOFF container holding one cmap table, the way D2 embeds a subsetted face in its SVG.
 * Only the character coverage matters to the code under test, so no outlines are included.
 */
export function face(characters, { compress = false } = {}) {
  const cmap = buildCmap([...characters].map((char) => char.codePointAt(0)));
  const stored = compress ? deflateSync(cmap) : cmap;

  const header = Buffer.alloc(44);
  header.write("wOFF", 0, "ascii");
  header.writeUInt32BE(0x0001_0000, 4);
  header.writeUInt32BE(44 + 20 + stored.length, 8);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(12 + 16 + cmap.length, 16);

  const directory = Buffer.alloc(20);
  directory.write("cmap", 0, "ascii");
  directory.writeUInt32BE(44 + 20, 4);
  directory.writeUInt32BE(stored.length, 8);
  directory.writeUInt32BE(cmap.length, 12);
  return Buffer.concat([header, directory, stored]);
}

function buildCmap(codes) {
  const segments = [...runs(codes), { start: 0xffff, end: 0xffff }];
  const count = segments.length;
  const subtable = Buffer.alloc(14 + count * 8 + 2);
  subtable.writeUInt16BE(4, 0);
  subtable.writeUInt16BE(subtable.length, 2);
  subtable.writeUInt16BE(count * 2, 6);

  const ends = 14;
  const starts = ends + count * 2 + 2;
  const deltas = starts + count * 2;
  segments.forEach((segment, index) => {
    subtable.writeUInt16BE(segment.end, ends + index * 2);
    subtable.writeUInt16BE(segment.start, starts + index * 2);
    // Glyph ids start at 1, since 0 means the face cannot draw the character.
    subtable.writeUInt16BE((1 - segment.start) & 0xffff, deltas + index * 2);
  });

  const table = Buffer.alloc(12 + subtable.length);
  table.writeUInt16BE(1, 2);
  table.writeUInt16BE(3, 4);
  table.writeUInt16BE(1, 6);
  table.writeUInt32BE(12, 8);
  subtable.copy(table, 12);
  return table;
}

function runs(codes) {
  const sorted = [...new Set(codes)].sort((left, right) => left - right);
  const segments = [];
  for (const code of sorted) {
    const last = segments.at(-1);
    if (last !== undefined && code === last.end + 1) {
      last.end = code;
    } else {
      segments.push({ start: code, end: code });
    }
  }
  return segments;
}
