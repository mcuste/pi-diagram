import { DiagramSourceError, describeInvalidValue } from "@mcuste/pi-diagram-core";

/**
 * What a diagram is for decides how it looks. The model names the purpose, this table sets the
 * engine, the theme, and the spacing, so diagrams stay consistent between calls.
 *
 * The policy reaches D2 as CLI flags, which take precedence over anything the source sets.
 */

/** Neutral Default: light containers under near-white nodes, which keeps the nesting readable. */
const NEUTRAL_THEME = 0;
/** Neutral Grey: no colour to lose, so it still reads when a document is printed. */
const GREY_THEME = 1;
/** C4, so a diagram drawn in that convention is coloured the way its readers expect. */
const C4_THEME = 303;
/** Dark Mauve, D2's neutral dark theme, so a saved SVG follows the reader into dark mode. */
const DARK_THEME = 200;

export const PROFILE_NAMES = [
  "explain",
  "architecture",
  "data",
  "docs",
  "tree",
  "c4",
  "dependency",
] as const;

export type ProfileName = (typeof PROFILE_NAMES)[number];

/** The engines expose different spacing options, so a profile states only its own engine's. */
export type LayoutPolicy =
  | {
      readonly engine: "elk";
      /** Pixels between one row of nodes and the next. */
      readonly layerGapPx: number;
      /** Pixels between a node and an edge routed past it. */
      readonly edgeGapPx: number;
      /** Pixels between a container's border and what it holds. */
      readonly containerPadPx: number;
    }
  | {
      readonly engine: "dagre";
      /** Pixels between one node and the next across a row. */
      readonly nodeGapPx: number;
      /** Pixels between two edges running side by side. */
      readonly edgeGapPx: number;
    };

export interface RenderProfile {
  readonly name: ProfileName;
  /** D2 theme id used in light mode. */
  readonly theme: number;
  /** D2 theme id a viewer in dark mode gets instead. */
  readonly darkTheme: number;
  /** Pixels around the whole drawing. */
  readonly padPx: number;
  /** Hand-drawn strokes and a handwriting font. */
  readonly sketch: boolean;
  readonly layout: LayoutPolicy;
}

const PROFILES: Readonly<Record<ProfileName, RenderProfile>> = {
  /**
   * The default. Drawn by hand because an answer in a conversation is a rough model, and a crisp
   * diagram claims more precision than the explanation has.
   */
  explain: {
    name: "explain",
    theme: NEUTRAL_THEME,
    darkTheme: DARK_THEME,
    padPx: 30,
    sketch: true,
    layout: { engine: "elk", layerGapPx: 60, edgeGapPx: 40, containerPadPx: 40 },
  },
  // Room between the ranks, so the edges crossing between containers stay separable.
  architecture: {
    name: "architecture",
    theme: NEUTRAL_THEME,
    darkTheme: DARK_THEME,
    padPx: 60,
    sketch: false,
    layout: { engine: "elk", layerGapPx: 90, edgeGapPx: 50, containerPadPx: 60 },
  },
  // Tables and classes are tall already, so the space around them is kept tight.
  data: {
    name: "data",
    theme: NEUTRAL_THEME,
    darkTheme: DARK_THEME,
    padPx: 30,
    sketch: false,
    layout: { engine: "elk", layerGapPx: 50, edgeGapPx: 30, containerPadPx: 30 },
  },
  // Sized for a page rather than a transcript row, with a theme that survives greyscale.
  docs: {
    name: "docs",
    theme: GREY_THEME,
    darkTheme: DARK_THEME,
    padPx: 100,
    sketch: false,
    layout: { engine: "elk", layerGapPx: 80, edgeGapPx: 40, containerPadPx: 50 },
  },
  /**
   * The one profile that changes engine: dagre fans children out under their parent, which is how
   * a hierarchy is normally drawn.
   */
  tree: {
    name: "tree",
    theme: NEUTRAL_THEME,
    darkTheme: DARK_THEME,
    padPx: 40,
    sketch: false,
    layout: { engine: "dagre", nodeGapPx: 40, edgeGapPx: 20 },
  },
  // Architecture spacing. The palette is the whole difference.
  c4: {
    name: "c4",
    theme: C4_THEME,
    darkTheme: DARK_THEME,
    padPx: 60,
    sketch: false,
    layout: { engine: "elk", layerGapPx: 90, edgeGapPx: 50, containerPadPx: 60 },
  },
  /**
   * For a graph with more nodes than usual. Edges routed past nodes fill most of a large graph, so
   * that gap is cut first.
   */
  dependency: {
    name: "dependency",
    theme: NEUTRAL_THEME,
    darkTheme: DARK_THEME,
    padPx: 20,
    sketch: false,
    layout: { engine: "elk", layerGapPx: 40, edgeGapPx: 20, containerPadPx: 20 },
  },
};

/** Diagrams that explain something in passing, which is most of them. */
export const DEFAULT_PROFILE: RenderProfile = PROFILES.explain;

export function parseProfile(raw: unknown): RenderProfile {
  if (raw === undefined) {
    return DEFAULT_PROFILE;
  }
  // Matched against the names, not looked up on the table, so `toString` cannot become a profile.
  const name = PROFILE_NAMES.find((candidate) => candidate === raw);
  if (name === undefined) {
    throw new DiagramSourceError("Unsupported diagram profile.", [
      {
        code: "D2_SOURCE",
        message: `${describeInvalidValue(raw)} is not a profile.`,
        hint: `Use ${PROFILE_NAMES.join(", ")}.`,
      },
    ]);
  }
  return PROFILES[name];
}
