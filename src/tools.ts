import { type Static, type TSchema, Type } from "typebox";
import { DiagramSourceError } from "./d2/diagnostics.js";
import { D2Cli, type D2Renderer } from "./d2/runner.js";
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

const DiagramSaveFormat = Type.Union([
  Type.Literal("source"),
  Type.Literal("svg"),
  Type.Literal("png"),
  Type.Literal("txt"),
]);

const DiagramSave = Type.Object(
  {
    dir: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_PATH_LENGTH,
        description: "Directory inside the workspace to write artifacts to.",
      }),
    ),
    basename: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_TITLE_LENGTH,
        description: "Stable file name stem, without an extension.",
      }),
    ),
    formats: Type.Optional(
      Type.Array(DiagramSaveFormat, {
        minItems: 1,
        uniqueItems: true,
        description: "Artifacts to write. Defaults to the editable source and an SVG.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description: "Write the diagram to the workspace. Omit it for a diagram shown only in chat.",
  },
);

const DiagramParameters = Type.Object(
  {
    source: DiagramSource,
    language: Type.Optional(DiagramLanguage),
    title: Type.Optional(DiagramTitle),
    profile: Type.Optional(DiagramProfile),
    render: Type.Optional(DiagramRender),
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
].join("\n");

/**
 * The diagram itself travels in `content` rather than here, because both hosts display that
 * without a custom renderer. It moves once the adapters own the display.
 */
interface DiagramToolDetails {
  readonly language: "d2";
  readonly title?: string;
  readonly profile: Static<typeof DiagramProfile>;
  readonly requested: Static<typeof DiagramRender>;
  readonly renderedAs: Representation;
  readonly sourceHash: string;
  readonly lineCount: number;
  readonly widthCells: number;
  readonly d2Version?: string;
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
}

function approvalFor(args: unknown): ToolApprovalDecision {
  return readSave(args) ? "write" : "read";
}

function approvalDetails(args: unknown): readonly string[] | undefined {
  const save = readSave(args);
  if (!save) {
    return undefined;
  }
  return [`Writes diagram artifacts to ${save.dir ?? "the default artifact directory"}.`];
}

function readSave(args: unknown): DiagramParameters["save"] | undefined {
  if (typeof args !== "object" || args === null) {
    return undefined;
  }
  const save = Reflect.get(args, "save");
  return typeof save === "object" && save !== null
    ? (save as DiagramParameters["save"])
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
  if (parameters.save !== undefined) {
    throw new DiagramSourceError("Saving diagram artifacts is not built yet.", [
      {
        code: "D2_SOURCE",
        message: "This version only shows diagrams in the transcript.",
        hint: "Call again without `save`.",
      },
    ]);
  }
}

function contentFor(rendering: DiagramRendering): string {
  const blocks = [
    rendering.title,
    rendering.text,
    ...rendering.notes.map((note) => `note: ${note}`),
  ];
  return blocks.filter((block): block is string => Boolean(block)).join("\n\n");
}

function detailsFor(
  parameters: DiagramParameters,
  rendering: DiagramRendering,
): DiagramToolDetails {
  return {
    language: "d2",
    ...(rendering.title === undefined ? {} : { title: rendering.title }),
    profile: parameters.profile ?? "explain",
    requested: parameters.render ?? "auto",
    renderedAs: rendering.renderedAs,
    sourceHash: rendering.sourceHash,
    lineCount: rendering.lineCount,
    widthCells: rendering.widthCells,
    ...(rendering.d2Version === undefined ? {} : { d2Version: rendering.d2Version }),
    ...(rendering.notes.length === 0 ? {} : { notes: rendering.notes }),
  };
}

export function registerDiagramTools(
  pi: DiagramExtensionApi,
  dependencies: DiagramExtensionDependencies = {},
): void {
  const renderer = dependencies.renderer ?? new D2Cli();

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
    async execute(_toolCallId, parameters, signal) {
      assertSupported(parameters);
      const rendering = await renderDiagram(
        {
          source: parameters.source,
          title: parameters.title,
          render: parameters.render,
          signal,
        },
        renderer,
      );
      return {
        content: [{ type: "text", text: contentFor(rendering) }],
        details: detailsFor(parameters, rendering),
      };
    },
  });
}
