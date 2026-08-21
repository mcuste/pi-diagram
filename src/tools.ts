import { type Static, type TSchema, Type } from "typebox";
import { parseArtifactNames, workspacePaths } from "./artifacts.js";
import { DiagramSourceError } from "./d2/diagnostics.js";
import { D2Cli, type D2Renderer } from "./d2/runner.js";
import {
  type Component,
  type DisplayContext,
  type DisplayTheme,
  imagesSupported,
  primeDisplay,
  renderDiagramImage,
} from "./display.js";
import { ResvgRasterizer, type SvgRasterizer } from "./raster.js";
import { type DiagramRendering, type Representation, renderDiagram } from "./render.js";

/**
 * Capped well below what D2 can parse: a diagram that reads clearly in a terminal is a few dozen
 * lines, and a larger one usually means the model is dumping a whole codebase.
 */
const MAX_SOURCE_LENGTH = 20_000;
const MAX_TITLE_LENGTH = 120;
const MAX_PATH_LENGTH = 255;

const DiagramSource = Type.String({
  minLength: 1,
  maxLength: MAX_SOURCE_LENGTH,
  description:
    "Diagram source in the declarative language named by `language`. Imports, local images, and remote icons are rejected.",
});

const DiagramLanguage = Type.Union([Type.Literal("d2"), Type.Literal("mermaid")], {
  description: "Source language. D2 is the native language; Mermaid exists for existing content.",
});

const DiagramTitle = Type.String({
  minLength: 1,
  maxLength: MAX_TITLE_LENGTH,
  description: "Short label shown with the diagram and used to name saved artifacts.",
});

const DiagramProfile = Type.Union(
  [
    Type.Literal("explain"),
    Type.Literal("architecture"),
    Type.Literal("data"),
    Type.Literal("docs"),
  ],
  {
    description:
      "What the diagram is for. The harness maps this to layout, theme, and spacing; the model does not choose them.",
  },
);

const DiagramRender = Type.Union(
  [
    Type.Literal("auto"),
    Type.Literal("image"),
    Type.Literal("unicode"),
    Type.Literal("ascii"),
    Type.Literal("source"),
  ],
  {
    description:
      "Preferred representation in the transcript. `auto` shows an image where the terminal supports it and Unicode text otherwise.",
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
    language: Type.Optional(DiagramLanguage),
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
  "Aim for 5 to 15 nodes; split anything larger into several diagrams.",
  "",
  "Files: `formats` produces .d2, .svg, .png, or .txt outside the repository and returns the",
  "paths. `save: { dir }` also copies them into the repository, so Markdown can reference the",
  "SVG. Only pass `save` when the user asked to keep the diagram; explaining something needs",
  "neither. A terminal that can show images shows one without being asked.",
].join("\n");

/** The text diagram travels in `content`, which both hosts display without a custom renderer. */
interface DiagramToolDetails {
  readonly language: "d2";
  readonly title?: string;
  readonly profile: Static<typeof DiagramProfile>;
  readonly requested: Static<typeof DiagramRender>;
  readonly renderedAs: DisplayedAs;
  readonly image?: { readonly path: string; readonly widthPx: number; readonly heightPx: number };
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
  /** Throwing here is the host's signal to render the result its own way. */
  readonly renderResult?: (
    result: { readonly content: readonly TextContent[]; readonly details: TDetails },
    options: { readonly expanded: boolean; readonly isPartial: boolean },
    theme: DisplayTheme,
    context: DisplayContext,
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

/** Only `save` reaches the repository. The temp store changes nothing worth approving. */
function approvalFor(args: unknown): ToolApprovalDecision {
  return readSave(args) === undefined ? "read" : "write";
}

/** Names the repository files at stake, so approving is a decision about specific paths. */
function approvalDetails(args: unknown): readonly string[] | undefined {
  const save = readSave(args);
  if (save === undefined) {
    return undefined;
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
    // The call itself will refuse with the reason; the prompt only needs the intent.
    return typeof save.dir === "string"
      ? [`Writes diagram artifacts into ${save.dir}`]
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

/** Refuses what the schema accepts but this build cannot honour, rather than ignoring it. */
function assertSupported(parameters: DiagramParameters): void {
  if (parameters.language !== undefined && parameters.language !== "d2") {
    throw new DiagramSourceError("Mermaid input is not enabled in this version.", [
      {
        code: "D2_SOURCE",
        message: `language ${JSON.stringify(parameters.language)} has no adapter yet.`,
        hint: "Send D2 source instead.",
      },
    ]);
  }
}

function contentFor(rendering: DiagramRendering): string {
  const paths = rendering.saved.map((artifact) => artifact.path).join(", ");
  const saved =
    rendering.saved.length === 0
      ? undefined
      : rendering.saved[0]?.location === "workspace"
        ? `saved in the repository: ${paths}`
        : `saved outside the repository: ${paths}`;
  const blocks = [
    rendering.title,
    rendering.text,
    saved,
    ...rendering.notes.map((note) => `note: ${note}`),
  ];
  return blocks.filter((block): block is string => Boolean(block)).join("\n\n");
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
    profile: parameters.profile ?? "explain",
    requested: parameters.render ?? "auto",
    renderedAs: rendering.image === undefined ? rendering.renderedAs : "image",
    ...(rendering.image === undefined ? {} : { image: rendering.image }),
    sourceHash: rendering.sourceHash,
    lineCount: rendering.lineCount,
    widthCells: rendering.widthCells,
    ...(rendering.d2Version === undefined ? {} : { d2Version: rendering.d2Version }),
    ...(outputs === undefined ? {} : { outputs }),
    ...(rendering.notes.length === 0 ? {} : { notes: rendering.notes }),
  };
}

/** Saved and temporary file paths, for the expanded view. */
function pathsFor(details: DiagramToolDetails): readonly string[] {
  return Object.entries(details.outputs ?? {})
    .filter(([key]) => key !== "location")
    .map(([, path]) => path);
}

export function registerDiagramTools(
  pi: DiagramExtensionApi,
  dependencies: DiagramExtensionDependencies = {},
): void {
  const renderer = dependencies.renderer ?? new D2Cli();
  const rasterizer = dependencies.rasterizer ?? new ResvgRasterizer();
  void primeDisplay();

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
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      assertSupported(parameters);
      const rendering = await renderDiagram(
        {
          source: parameters.source,
          title: parameters.title,
          render: parameters.render,
          formats: parameters.formats,
          save: parameters.save,
          cwd: context.cwd,
          // Drawing an image a terminal cannot show would cost an SVG render for nothing.
          images: context.mode === "tui" && imagesSupported() !== false,
          signal,
        },
        renderer,
        rasterizer,
      );
      return {
        content: [{ type: "text", text: contentFor(rendering) }],
        details: detailsFor(parameters, rendering),
      };
    },
    renderResult(result, options, theme, context) {
      const image = result.details.image;
      if (image === undefined) {
        throw new Error("This diagram has no image, so the host renders its text.");
      }
      return renderDiagramImage(
        {
          image,
          title: result.details.title,
          paths: pathsFor(result.details),
          notes: result.details.notes ?? [],
        },
        theme,
        { showImages: context.showImages, expanded: options.expanded, state: context.state },
      );
    },
  });
}
