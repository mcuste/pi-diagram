import { readFile } from "node:fs/promises";

let guidance: string | undefined;
let guidanceLoading: Promise<void> | undefined;

/** Reads the editable prompt once before the host can invoke the hook. */
export function primeDiagramGuidance(): Promise<void> {
  guidanceLoading ??= readFile(new URL("./guidance.md", import.meta.url), "utf8").then((source) => {
    guidance = source.trimEnd();
    if (guidance === "") {
      throw new Error("Diagram guidance is empty.");
    }
  });
  return guidanceLoading;
}

function cachedGuidance(): string {
  if (guidance === undefined) {
    throw new Error("Diagram guidance has not loaded.");
  }
  return guidance;
}

/** Pi hands over one prompt string; Oh My Pi hands over ordered blocks. */
type HostSystemPrompt = string | readonly string[];

interface AgentStartEvent {
  readonly systemPrompt?: HostSystemPrompt;
  /** Only Pi reports what it built the prompt from. */
  readonly systemPromptOptions?: { readonly selectedTools?: readonly string[] };
}

interface AgentStartResult {
  readonly systemPrompt: HostSystemPrompt;
}

export interface GuidanceExtensionApi {
  on?(
    event: "before_agent_start",
    handler: (event: AgentStartEvent) => AgentStartResult | undefined,
  ): void;
}

export async function registerDiagramGuidance(pi: GuidanceExtensionApi): Promise<void> {
  await primeDiagramGuidance();
  pi.on?.("before_agent_start", withGuidance);
}

/**
 * The hook replaces the prompt, so returning the guidance alone would drop everything the host
 * built. A prompt that cannot be read is left as it is.
 */
export function withGuidance(event: AgentStartEvent): AgentStartResult | undefined {
  const prompt = event.systemPrompt;
  if (!toolActive(event)) {
    return undefined;
  }
  const guidance = cachedGuidance();
  if (typeof prompt === "string") {
    return prompt === "" || prompt.includes(guidance)
      ? undefined
      : { systemPrompt: `${prompt}\n\n${guidance}` };
  }
  if (!Array.isArray(prompt) || prompt.length === 0 || prompt.includes(guidance)) {
    return undefined;
  }
  return { systemPrompt: [...prompt, guidance] };
}

/** Telling the model to draw with a tool the user turned off would waste a turn. */
function toolActive(event: AgentStartEvent): boolean {
  const tools = event.systemPromptOptions?.selectedTools;
  return tools === undefined || tools.includes("diagram");
}
