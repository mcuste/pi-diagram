const ELLIPSIS = "…";
const ESC = "\u001b";
const BEL = "\u0007";
// CSI sequences such as colors, and OSC sequences such as hyperlinks.
const ESCAPE_SEQUENCES = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
  "gu",
);
const segmenter = new Intl.Segmenter();

/**
 * Counts every non-ASCII grapheme as two columns, so the cut is never too wide.
 * A cut line loses its colors and links.
 */
export function truncateWithoutHost(text: string, width: number): string {
  const untabbed = text.replaceAll("\t", "   ");
  const plain = untabbed.replace(ESCAPE_SEQUENCES, "");
  const segments = [...segmenter.segment(plain)].map(({ segment }) => ({
    segment,
    columns: /^[ -~]$/u.test(segment) ? 1 : 2,
  }));
  const total = segments.reduce((sum, { columns }) => sum + columns, 0);
  if (total <= width) {
    return untabbed;
  }
  const ellipsisColumns = 2;
  const limit = width - ellipsisColumns;
  let kept = "";
  let used = 0;
  for (const { segment, columns } of segments) {
    if (used + columns > limit) {
      break;
    }
    kept += segment;
    used += columns;
  }
  return width < ellipsisColumns ? kept : `${kept}${ELLIPSIS}`;
}
