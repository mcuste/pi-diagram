import { type Static, type TSchema, Type } from "typebox";
import {
  parseRenderPreference,
  type RenderPreference,
  type RenderPreferenceOptions,
  resolveRenderPreference,
} from "./config.js";

export type { RenderPreference } from "./config.js";
export { parseRenderPreference } from "./config.js";

import { parseArtifactNames, workspacePaths } from "./artifacts.js";
import { type Diagnostic, formatDiagnostic } from "./d2/diagnostics.js";
import { DEFAULT_PROFILE, type ProfileName } from "./d2/profiles.js";
import { D2Cli, type D2Renderer } from "./d2/runner.js";
import {
  type Component,
  type DiagramCallView,
  type DisplayContext,
  type DisplayTheme,
  displayLoaded,
  imagesSupported,
  primeDisplay,
  renderDiagramCall,
  renderDiagramResult,
} from "./display.js";
import { ResvgRasterizer, type SvgRasterizer } from "./raster.js";
import { type DiagramRendering, type Representation, renderDiagram } from "./render.js";
import { removeTerminalControls } from "./terminal.js";

/**
 * Capped well below what D2 can parse: a diagram that reads clearly in a terminal is a few dozen
 * lines, and a larger one usually means the model is dumping a whole codebase.
 */
const MAX_SOURCE_LENGTH = 20_000;
const MAX_TITLE_LENGTH = 120;
const MAX_PATH_LENGTH = 255;

const DEFAULT_RENDER_PREFERENCE: RenderPreference = "unicode";
const IMAGE_UNAVAILABLE_WARNING = "Image support is unavailable; generated as Unicode.";
const RENDER_FLAG = "diagram-render";

export interface DiagramPreferenceApi {
  registerFlag(
    name: string,
    options: { readonly description: string; readonly type: "string"; readonly default?: string },
  ): void;
  getFlag(name: string): boolean | string | undefined;
}

export async function registerDiagramPreference(
  pi: DiagramPreferenceApi,
  options: RenderPreferenceOptions = {},
): Promise<(cwd?: string) => Promise<RenderPreference>> {
  pi.registerFlag(RENDER_FLAG, {
    description: "Default diagram rendering: unicode or image",
    type: "string",
  });
  return async (cwd) => {
    const flagPreference = pi.getFlag(RENDER_FLAG);
    if (flagPreference !== undefined) {
      return parseRenderPreference(flagPreference);
    }
    return resolveRenderPreference({
      ...options,
      ...(cwd === undefined ? {} : { cwd }),
    });
  };
}

const DiagramSource = Type.String({
  minLength: 1,
  maxLength: MAX_SOURCE_LENGTH,
  description: "Diagram source in D2. Imports, local images, and remote icons are rejected.",
});

const DiagramTitle = Type.String({
  minLength: 1,
  maxLength: MAX_TITLE_LENGTH,
  description: "Short label shown with the diagram and used to name saved artifacts.",
});

/** One literal per profile, because a mapped union loses the names from the static type. */
const DiagramProfile = Type.Union(
  [
    Type.Literal("explain"),
    Type.Literal("architecture"),
    Type.Literal("data"),
    Type.Literal("docs"),
    Type.Literal("tree"),
    Type.Literal("c4"),
    Type.Literal("dependency"),
  ],
  {
    description:
      "What the diagram is for. The harness maps this to theme and spacing; the model does not choose them.",
  },
);

const DiagramRender = Type.Union(
  [Type.Literal("auto"), Type.Literal("image"), Type.Literal("unicode"), Type.Literal("source")],
  {
    description:
      "`auto` uses the user's diagram render preference. Explicit `image`, `unicode`, and `source` override it for this call.",
  },
);

const DiagramFormat = Type.Union([
  Type.Literal("source"),
  Type.Literal("svg"),
  Type.Literal("png"),
  Type.Literal("txt"),
]);

const DiagramFormats = Type.Array(DiagramFormat, {
  minItems: 1,
  uniqueItems: true,
  description:
    "Files to produce. They are written outside the repository and their paths are returned. Defaults to editable source and an SVG.",
});

/** What the transcript shows, which is not always the text representation that was prepared. */
type DisplayedAs = Representation | "image";

const DiagramSave = Type.Object(
  {
    dir: Type.String({
      minLength: 1,
      maxLength: MAX_PATH_LENGTH,
      description:
        "Directory inside the workspace to copy the files into. There is no default: name where diagrams belong in this repository.",
    }),
    basename: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_TITLE_LENGTH,
        description: "Stable file name stem, without an extension. Defaults to the title.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "Copy the files into the repository. Use it only when the user asked to keep the diagram.",
  },
);

const DiagramParameters = Type.Object(
  {
    source: DiagramSource,
    title: Type.Optional(DiagramTitle),
    profile: Type.Optional(DiagramProfile),
    render: Type.Optional(DiagramRender),
    formats: Type.Optional(DiagramFormats),
    save: Type.Optional(DiagramSave),
  },
  { additionalProperties: false },
);

type DiagramParameters = Static<typeof DiagramParameters>;

const DIAGRAM_DESCRIPTION = [
  "Draw a diagram from D2 source and show it in the terminal. Use it when architecture,",
  "relationships, sequence, data flow, state transitions, schemas, or process flow are easier to",
  "see than to read, and keep the diagram to what answers the question.",
  "",
  "D2 in brief:",
  "  edges       client -> gateway: request",
  "  containers  core: Core Services { api; worker }, then core.api -> core.worker",
  "  sequence    flow: { shape: sequence_diagram; user -> api: submit }",
  "  tables      users: { shape: sql_table; id: int {constraint: primary_key}; email: varchar }",
  "",
  "Not allowed: `@` imports, `icon`, `link`, `shape: image`, and `|...|` block labels.",
  "Do not set colours, themes, or fonts. This tool owns how diagrams look.",
  "Aim for 5 to 15 nodes, or up to about 25 with `profile: dependency`. Split anything larger.",
  "",
  "`profile` says what the diagram is for, and sets the layout, theme, and spacing:",
  "  explain      an answer in this conversation, drawn by hand. The default",
  "  architecture systems and components, with room between the parts",
  "  data         schemas, tables, class relationships",
  "  docs         a diagram that will be checked into the repository",
  "  tree         a hierarchy: an org chart, a call tree, a file layout",
  "  c4           the C4 convention, with the palette its readers expect",
  "  dependency   a graph with more nodes than usual, drawn dense",
  "",
  "Files: `formats` produces .d2, .svg, .png, or .txt outside the repository and returns the",
  "paths. `save: { dir }` also copies them into the repository, so Markdown can reference the",
  "SVG. Only pass `save` when the user asked to keep the diagram; explaining something needs",
  "neither. `auto` uses the user's render preference, which defaults to Unicode.",
].join("\n");

/**
 * `content` goes to the model and `details` only to the screen, so the diagram travels in
 * `details` whenever this package draws the row itself.
 */
interface DiagramToolDetails {
  readonly language: "d2";
  readonly title?: string;
  readonly profile: ProfileName;
  readonly requested: Static<typeof DiagramRender>;
  readonly effectiveRender: Exclude<Static<typeof DiagramRender>, "auto">;
  readonly imageSupported: boolean;
  readonly renderedAs: DisplayedAs;
  readonly image?: { readonly path: string; readonly widthPx: number; readonly heightPx: number };
  /** The diagram as text, for the renderer and as the fallback for an image. */
  readonly textPreview: string;
  /** The D2 source, shown in the expanded row. */
  readonly source: string;
  readonly diagnostics?: readonly Diagnostic[];
  readonly sourceHash: string;
  readonly lineCount: number;
  readonly widthCells: number;
  readonly d2Version?: string;
  readonly outputs?: Readonly<Record<string, string>>;
  readonly notes?: readonly string[];
}

interface TextContent {
  readonly type: "text";
  readonly text: string;
}

interface ToolResult<TDetails> {
  readonly content: readonly TextContent[];
  readonly details: TDetails;
}

interface ToolContext {
  readonly cwd: string;
  /** Only a terminal UI can display an image; print and RPC modes never can. */
  readonly mode?: "tui" | "rpc" | "json" | "print";
  readonly ui?: {
    confirm(title: string, message: string): Promise<boolean>;
  };
}

type ToolTier = "read" | "write" | "exec";

type ToolApprovalDecision =
  | ToolTier
  | {
      readonly tier: ToolTier;
      readonly reason?: string;
      readonly policy?: "allow" | "deny" | "prompt";
    };

interface ToolDefinition<TParameters extends TSchema, TDetails> {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TParameters;
  readonly approval: ToolApprovalDecision | ((args: unknown) => ToolApprovalDecision);
  readonly loadMode: "essential" | "discoverable";
  readonly concurrency?:
    | "shared"
    | "exclusive"
    | ((args: Partial<Static<TParameters>>) => "shared" | "exclusive");
  readonly executionMode?: "sequential" | "parallel";
  readonly formatApprovalDetails?: (args: unknown) => string | readonly string[] | undefined;
  /** Arguments can still be arriving, so every field is read defensively. */
  readonly renderCall?: (args: Partial<Static<TParameters>>, theme: DisplayTheme) => Component;
  /** Throwing here is the host's signal to render the result its own way. */
  readonly renderResult?: (
    result: { readonly content: readonly TextContent[]; readonly details: TDetails },
    options: { readonly expanded: boolean; readonly isPartial: boolean },
    theme: DisplayTheme,
    context?: unknown,
  ) => Component;
  execute(
    toolCallId: string,
    parameters: Static<TParameters>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: ToolContext,
  ): Promise<ToolResult<TDetails>>;
}

const fallbackDisplayStates = new WeakMap<object, Record<string, unknown>>();

function displayContextFor(
  details: DiagramToolDetails,
  expanded: boolean,
  context: unknown,
): DisplayContext {
  const record =
    typeof context === "object" && context !== null
      ? (context as Record<string, unknown>)
      : undefined;
  const hostState = record?.state;
  let state =
    typeof hostState === "object" && hostState !== null
      ? (hostState as Record<string, unknown>)
      : fallbackDisplayStates.get(details);
  if (state === undefined) {
    state = {};
    fallbackDisplayStates.set(details, state);
  }
  return {
    // OMP passes tool arguments here instead of Pi's row context.
    showImages: typeof record?.showImages === "boolean" ? record.showImages : true,
    expanded,
    state,
  };
}

export interface DiagramExtensionApi {
  registerTool<TParameters extends TSchema, TDetails>(
    definition: ToolDefinition<TParameters, TDetails>,
  ): void;
}

export interface DiagramExtensionDependencies {
  readonly renderer?: D2Renderer;
  readonly rasterizer?: SvgRasterizer;
  readonly renderPreference?: (cwd: string) => RenderPreference | Promise<RenderPreference>;
}

/** Only `save` reaches the repository. Its presence is write intent even when malformed. */
function approvalFor(args: unknown): ToolApprovalDecision {
  return hasSave(args) ? "write" : "read";
}

/** Names the repository files at stake, so approving is a decision about specific paths. */
function approvalDetails(args: unknown): readonly string[] | undefined {
  if (!hasSave(args)) {
    return undefined;
  }
  const save = readSave(args);
  if (save === undefined) {
    return ["Writes diagram artifacts into the repository"];
  }
  const read = (key: string): unknown =>
    typeof args === "object" && args !== null ? Reflect.get(args, key) : undefined;
  try {
    const title = read("title");
    const names = parseArtifactNames(
      { formats: read("formats"), save },
      { title: typeof title === "string" ? title : undefined, hash: "" },
    );
    return workspacePaths(names).map((path) => `Writes ${path}`);
  } catch {
    return typeof save.dir === "string"
      ? [`Writes diagram artifacts into ${removeTerminalControls(save.dir)}`]
      : ["Writes diagram artifacts into the repository"];
  }
}

function readSave(args: unknown): Record<string, unknown> | undefined {
  if (typeof args !== "object" || args === null) {
    return undefined;
  }
  const save = Reflect.get(args, "save");
  return typeof save === "object" && save !== null && !Array.isArray(save)
    ? (save as Record<string, unknown>)
    : undefined;
}

function hasSave(args: unknown): boolean {
  return typeof args === "object" && args !== null && Object.hasOwn(args, "save");
}

/** The waiting row names the diagram and the policy, never the source. */
function callView(args: Partial<DiagramParameters>): DiagramCallView {
  const title = typeof args.title === "string" ? removeTerminalControls(args.title).trim() : "";
  const source = typeof args.source === "string" ? args.source : "";
  const lines = source.split("\n").filter((line) => line.trim().length > 0).length;
  const directory = readSave(args)?.dir;
  const saving =
    typeof directory === "string" ? `, saving into ${removeTerminalControls(directory)}` : "";
  const profile =
    typeof args.profile === "string" ? removeTerminalControls(args.profile) : DEFAULT_PROFILE.name;
  return {
    subject: title === "" ? `${lines} line${lines === 1 ? "" : "s"}` : `"${title}"`,
    note: `(${profile}${saving})`,
  };
}

const DRAWN: Readonly<Record<DisplayedAs, string>> = {
  image: "an image",
  unicode: "box drawing",
  source: "D2 source",
};

/** Prevents the model from redrawing a diagram omitted from its context. */
function contentFor(
  rendering: DiagramRendering,
  drawnHere: boolean,
  notes: readonly string[],
): string {
  const paths = rendering.saved.map((artifact) => artifact.path).join(", ");
  const saved =
    rendering.saved.length === 0
      ? undefined
      : rendering.saved[0]?.location === "workspace"
        ? `saved in the repository: ${paths}`
        : `saved outside the repository: ${paths}`;
  const blocks = drawnHere ? [summaryFor(rendering)] : [rendering.title, rendering.text];
  return [...blocks, saved, ...notes.map((note) => `note: ${note}`)]
    .filter((block): block is string => Boolean(block))
    .join("\n\n");
}

function summaryFor(rendering: DiagramRendering): string {
  const named = rendering.title === undefined ? "the diagram" : `"${rendering.title}"`;
  const as = DRAWN[rendering.image === undefined ? rendering.renderedAs : "image"];
  return `Drew ${named} as ${as}. It is on the user's screen, so it is not repeated here.`;
}

function outputsFor(rendering: DiagramRendering): Readonly<Record<string, string>> | undefined {
  if (rendering.saved.length === 0) {
    return undefined;
  }
  const keys = {
    source: "sourcePath",
    svg: "svgPath",
    png: "pngPath",
    txt: "textPath",
  } as const;
  return {
    location: rendering.saved[0]?.location ?? "temp",
    ...Object.fromEntries(
      rendering.saved.map((artifact) => [keys[artifact.format], artifact.path]),
    ),
  };
}

function detailsFor(
  parameters: DiagramParameters,
  rendering: DiagramRendering,
  effectiveRender: DiagramToolDetails["effectiveRender"],
  imageSupported: boolean,
  notes: readonly string[],
): DiagramToolDetails {
  const outputs = outputsFor(rendering);
  return {
    language: "d2",
    ...(rendering.title === undefined ? {} : { title: rendering.title }),
    profile: rendering.profile,
    requested: parameters.render ?? "auto",
    effectiveRender,
    imageSupported,
    renderedAs: rendering.image === undefined ? rendering.renderedAs : "image",
    ...(rendering.image === undefined ? {} : { image: rendering.image }),
    textPreview: rendering.text,
    source: rendering.source,
    ...(rendering.diagnostics.length === 0 ? {} : { diagnostics: rendering.diagnostics }),
    sourceHash: rendering.sourceHash,
    lineCount: rendering.lineCount,
    widthCells: rendering.widthCells,
    ...(rendering.d2Version === undefined ? {} : { d2Version: rendering.d2Version }),
    ...(outputs === undefined ? {} : { outputs }),
    ...(notes.length === 0 ? {} : { notes }),
  };
}

function pathsFor(details: DiagramToolDetails): readonly string[] {
  return Object.entries(details.outputs ?? {})
    .filter(([key]) => key !== "location")
    .map(([, path]) => path);
}

function expandedLines(details: DiagramToolDetails): readonly string[] {
  const version = details.d2Version === undefined ? "" : `, D2 ${details.d2Version}`;
  const selection =
    details.requested === "auto"
      ? `Requested auto, resolved to ${details.effectiveRender}`
      : `Requested ${details.requested}`;
  const lines = [
    `${selection}; drawn as ${DRAWN[details.renderedAs]}, profile ${details.profile}${version}`,
    ...pathsFor(details),
    ...(details.diagnostics ?? []).map(formatDiagnostic),
  ];
  // The collapsed row already shows the source when that is what was drawn.
  return details.renderedAs === "source" ? lines : [...lines, "", details.source];
}

export function registerDiagramTools(
  pi: DiagramExtensionApi,
  dependencies: DiagramExtensionDependencies = {},
): void {
  const renderer = dependencies.renderer ?? new D2Cli();
  const rasterizer = dependencies.rasterizer ?? new ResvgRasterizer();
  const renderPreference = dependencies.renderPreference ?? (() => DEFAULT_RENDER_PREFERENCE);
  const display = primeDisplay();

  pi.registerTool<typeof DiagramParameters, DiagramToolDetails>({
    name: "diagram",
    label: "Diagram",
    description: DIAGRAM_DESCRIPTION,
    parameters: DiagramParameters,
    approval: approvalFor,
    formatApprovalDetails: approvalDetails,
    loadMode: "discoverable",
    concurrency: "shared",
    executionMode: "parallel",
    renderCall(args, theme) {
      return renderDiagramCall(callView(args), theme);
    },
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      let drawnHere = false;
      if (context.mode === "tui") {
        // Direct registrations can call the tool before the display import finishes.
        await display;
        drawnHere = displayLoaded();
      }
      const effectiveRender =
        parameters.render === undefined || parameters.render === "auto"
          ? await renderPreference(context.cwd)
          : parameters.render;
      const imageSupported = drawnHere && imagesSupported() === true;
      const rendering = await renderDiagram(
        {
          source: parameters.source,
          title: parameters.title,
          profile: parameters.profile,
          render: effectiveRender,
          formats: parameters.formats,
          save: parameters.save,
          cwd: context.cwd,
          images: imageSupported,
          signal,
        },
        renderer,
        rasterizer,
      );
      const notes =
        effectiveRender === "image" && !imageSupported
          ? [...rendering.notes, IMAGE_UNAVAILABLE_WARNING]
          : rendering.notes;
      return {
        content: [{ type: "text", text: contentFor(rendering, drawnHere, notes) }],
        details: detailsFor(parameters, rendering, effectiveRender, imageSupported, notes),
      };
    },
    renderResult(result, options, theme, context) {
      const details = result.details;
      const displayContext = displayContextFor(details, options.expanded, context);
      const imageUnavailable =
        details.effectiveRender === "image" &&
        (!details.imageSupported || !displayContext.showImages || imagesSupported() !== true);
      const notes =
        imageUnavailable && !details.notes?.includes(IMAGE_UNAVAILABLE_WARNING)
          ? [...(details.notes ?? []), IMAGE_UNAVAILABLE_WARNING]
          : (details.notes ?? []);
      return renderDiagramResult(
        {
          image: details.image,
          title: details.title,
          text: details.textPreview,
          notes,
          details: expandedLines(details),
        },
        theme,
        displayContext,
      );
    },
  });
}
