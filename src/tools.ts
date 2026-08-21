import { type Static, type TSchema, Type } from "typebox";

/**
 * Source is capped well below what D2 can parse: a diagram that reads clearly in a terminal is
 * a few dozen lines, and a larger one is usually a sign the model is dumping a whole codebase.
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

/**
 * What the harness needs to draw the result and what an expanded view shows. Kept out of the
 * content sent to the model so a base64 image or a full text diagram never re-enters its context.
 */
interface DiagramToolDetails {
  readonly language: Static<typeof DiagramLanguage>;
  readonly title?: string;
  readonly renderedAs: Exclude<Static<typeof DiagramRender>, "auto">;
  readonly sourceHash: string;
  readonly diagnostics?: readonly {
    readonly line?: number;
    readonly column?: number;
    readonly message: string;
  }[];
  readonly outputs: {
    readonly svgPath?: string;
    readonly pngPath?: string;
    readonly textPath?: string;
    readonly sourcePath?: string;
  };
  readonly textPreview?: string;
  readonly widthCells?: number;
  readonly heightCells?: number;
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

/** Thrown while the renderer is unbuilt. */
export class DiagramRendererUnavailableError extends Error {
  constructor() {
    super(
      "Diagram rendering is not implemented yet. This package currently only declares the tool contract.",
    );
    this.name = "DiagramRendererUnavailableError";
  }
}

/** Persisting artifacts writes into the workspace; a diagram shown only in chat does not. */
function approvalFor(args: unknown): ToolApprovalDecision {
  const save = (args as Partial<DiagramParameters> | undefined)?.save;
  return save ? "write" : "read";
}

function approvalDetails(args: unknown): readonly string[] | undefined {
  const save = (args as Partial<DiagramParameters> | undefined)?.save;
  if (!save) {
    return undefined;
  }
  return [`Writes diagram artifacts to ${save.dir ?? "the default artifact directory"}.`];
}

export function registerDiagramTools(pi: DiagramExtensionApi): void {
  pi.registerTool<typeof DiagramParameters, DiagramToolDetails>({
    name: "diagram",
    label: "Diagram",
    description:
      "Create and render a diagram from declarative source. Prefer D2. Use this tool when architecture, relationships, sequence, data flow, state transitions, schemas, or process flow are easier to understand visually than as prose. Keep diagrams focused on the user's question; omit incidental implementation detail. Do not spend tokens on cosmetic styling unless it communicates meaning. The harness applies a consistent visual profile automatically.",
    parameters: DiagramParameters,
    approval: approvalFor,
    formatApprovalDetails: approvalDetails,
    loadMode: "discoverable",
    concurrency: "shared",
    executionMode: "parallel",
    execute() {
      return Promise.reject(new DiagramRendererUnavailableError());
    },
  });
}
