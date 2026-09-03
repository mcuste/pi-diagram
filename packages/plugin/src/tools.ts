import { readFile } from "node:fs/promises";
import {
  type Diagnostic,
  formatDiagnostic,
  parseArtifactNames,
  removeTerminalControls,
  workspacePaths,
} from "@mcuste/pi-diagram-core";
import {
  D2Cli,
  type D2Renderer,
  DEFAULT_PROFILE,
  type DiagramRendering,
  type ProfileName,
  type Representation,
  ResvgRasterizer,
  renderDiagram,
  type SvgRasterizer,
} from "@mcuste/pi-diagram-d2";
import {
  type Component,
  type DiagramCallView,
  type DiagramResultView,
  type DisplayedAs,
  type DisplayTheme,
  isOmpRenderContext,
  ompDisplay,
  piDisplay,
  primeDisplay,
  updateOmpDiagramOverlay,
} from "@mcuste/pi-diagram-display";
import { type Static, type TSchema, Type } from "typebox";

/**
 * Capped well below what D2 can parse: a diagram that reads clearly in a terminal is a few dozen
 * lines, and a larger one usually means the model is dumping a whole codebase.
 */
const MAX_SOURCE_LENGTH = 20_000;
const MAX_TITLE_LENGTH = 120;
const MAX_PATH_LENGTH = 255;

let diagramDescription: string | undefined;
let diagramDescriptionLoading: Promise<void> | undefined;

export function primeDiagramDescription(): Promise<void> {
  diagramDescriptionLoading ??= readFile(
    new URL("./tool-description.md", import.meta.url),
    "utf8",
  ).then((source) => {
    diagramDescription = source.trimEnd();
    if (diagramDescription === "") {
      throw new Error("Diagram tool description is empty.");
    }
  });
  return diagramDescriptionLoading;
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
      "`auto` prepares complete Unicode and PNG views. Ctrl+O replaces Unicode in Pi or opens OMP's latest PNG in a fullscreen overlay. Explicit modes override the display for this call.",
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
    "Artifacts to write and return. Defaults to editable source and SVG; use SVG in documents.",
});

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

/**
 * `content` goes to the model and `details` only to the screen, so the diagram travels in
 * `details` whenever this package draws the row itself.
 */
interface DiagramToolDetails {
  readonly language: "d2";
  readonly title?: string;
  readonly profile: ProfileName;
  readonly requested: Static<typeof DiagramRender>;
  readonly renderedAs: Representation;
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
  /** Pi identifies TUI mode directly; OMP exposes the same fact as `hasUI`. */
  readonly mode?: "tui" | "rpc" | "json" | "print";
  readonly hasUI?: boolean;
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
  /** Pi passes the theme second; OMP passes render options before it. */
  readonly renderCall?: (
    args: Partial<Static<TParameters>>,
    themeOrOptions: DisplayTheme | unknown,
    theme?: DisplayTheme,
  ) => Component;
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

export interface DiagramExtensionApi {
  registerTool<TParameters extends TSchema, TDetails>(
    definition: ToolDefinition<TParameters, TDetails>,
  ): void;
}

export interface DiagramExtensionDependencies {
  readonly renderer?: D2Renderer;
  readonly rasterizer?: SvgRasterizer;
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
  const saveDirectory =
    typeof directory === "string" ? removeTerminalControls(directory) : undefined;
  const profile =
    typeof args.profile === "string" ? removeTerminalControls(args.profile) : DEFAULT_PROFILE.name;
  return {
    subject: title === "" ? `${lines} line${lines === 1 ? "" : "s"}` : `"${title}"`,
    profile,
    saveDirectory,
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
  const blocks = drawnHere ? [summaryFor(rendering)] : [rendering.title, rendering.display.content];
  return [...blocks, saved, ...notes.map((note) => `note: ${note}`)]
    .filter((block): block is string => Boolean(block))
    .join("\n\n");
}

function summaryFor(rendering: DiagramRendering): string {
  const named = rendering.title === undefined ? "the diagram" : `"${rendering.title}"`;
  return `Drew ${named}. It is on the user's screen, so it is not repeated here.`;
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
): DiagramToolDetails {
  const outputs = outputsFor(rendering);
  return {
    language: "d2",
    ...(rendering.title === undefined ? {} : { title: rendering.title }),
    profile: rendering.profile,
    requested: parameters.render ?? "auto",
    renderedAs: rendering.display.kind,
    ...(rendering.image === undefined ? {} : { image: rendering.image }),
    textPreview: rendering.display.content,
    source: rendering.source,
    ...(rendering.diagnostics.length === 0 ? {} : { diagnostics: rendering.diagnostics }),
    sourceHash: rendering.sourceHash,
    lineCount: rendering.lineCount,
    widthCells: rendering.widthCells,
    ...(rendering.d2Version === undefined ? {} : { d2Version: rendering.d2Version }),
    ...(outputs === undefined ? {} : { outputs }),
    ...(rendering.notes.length === 0 ? {} : { notes: rendering.notes }),
  };
}

function pathsFor(details: DiagramToolDetails): readonly string[] {
  return Object.entries(details.outputs ?? {})
    .filter(([key]) => key !== "location")
    .map(([, path]) => path);
}

function expandedLines(details: DiagramToolDetails, displayedAs: DisplayedAs): readonly string[] {
  const version = details.d2Version === undefined ? "" : `, D2 ${details.d2Version}`;
  const selection =
    details.requested === "auto" ? "Default view Unicode" : `Requested ${details.requested}`;
  const lines = [
    `${selection}; shown as ${DRAWN[displayedAs]}, profile ${details.profile}${version}`,
    ...pathsFor(details),
    ...(details.diagnostics ?? []).map(formatDiagnostic),
  ];
  return displayedAs === "source" ? lines : [...lines, "", details.source];
}

function displayView(details: DiagramToolDetails): DiagramResultView {
  return {
    requested: details.requested,
    display: { format: details.renderedAs, content: details.textPreview },
    image: details.image,
    title: details.title,
    notes: details.notes ?? [],
    details: (displayedAs) => expandedLines(details, displayedAs),
  };
}

export function registerDiagramTools(
  pi: DiagramExtensionApi,
  dependencies: DiagramExtensionDependencies = {},
): void {
  const description = diagramDescription;
  if (description === undefined) {
    throw new Error("Diagram tool description has not loaded.");
  }
  const renderer = dependencies.renderer ?? new D2Cli();
  const rasterizer = dependencies.rasterizer ?? new ResvgRasterizer();
  const display = primeDisplay();

  pi.registerTool<typeof DiagramParameters, DiagramToolDetails>({
    name: "diagram",
    label: "Diagram",
    description,
    parameters: DiagramParameters,
    approval: approvalFor,
    formatApprovalDetails: approvalDetails,
    loadMode: "discoverable",
    concurrency: "shared",
    executionMode: "parallel",
    renderCall(args, themeOrOptions, ompTheme) {
      const theme =
        ompTheme ??
        (typeof themeOrOptions === "object" &&
        themeOrOptions !== null &&
        typeof Reflect.get(themeOrOptions, "fg") === "function"
          ? (themeOrOptions as DisplayTheme)
          : undefined);
      if (theme === undefined) {
        throw new Error("The host did not provide a display theme.");
      }
      const display = ompTheme === undefined ? piDisplay : ompDisplay;
      return display.renderCall(callView(args), theme);
    },
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      const hasTui = context.mode === "tui" || context.hasUI === true;
      if (hasTui) {
        await display;
      }
      const drawnHere = context.mode === "tui";
      const rendering = await renderDiagram(
        {
          source: parameters.source,
          title: parameters.title,
          profile: parameters.profile,
          render: parameters.render,
          formats: parameters.formats,
          save: parameters.save,
          cwd: context.cwd,
          signal,
        },
        renderer,
        rasterizer,
      );
      updateOmpDiagramOverlay(
        context,
        { image: rendering.image, title: rendering.title },
        (parameters.render ?? "auto") === "auto",
      );
      return {
        content: [{ type: "text", text: contentFor(rendering, drawnHere, rendering.notes) }],
        details: detailsFor(parameters, rendering),
      };
    },
    renderResult(result, options, theme, context) {
      const details = result.details;
      const view = displayView(details);
      if (isOmpRenderContext(context)) {
        const displayContext = ompDisplay.resolveContext(details, options, context);
        return ompDisplay.renderResult(view, options, theme, displayContext);
      }
      const displayContext = piDisplay.resolveContext(details, options, context);
      return piDisplay.renderResult(view, options, theme, displayContext);
    },
  });
}
