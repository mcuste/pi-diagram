import { textAsset } from "./assets.js";

const guidance = textAsset(new URL("./guidance.md", import.meta.url), "Diagram guidance");

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
  await guidance.prime();
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
  const text = guidance.read();
  if (typeof prompt === "string") {
    return prompt === "" || prompt.includes(text)
      ? undefined
      : { systemPrompt: `${prompt}\n\n${text}` };
  }
  if (!Array.isArray(prompt) || prompt.length === 0 || prompt.includes(text)) {
    return undefined;
  }
  return { systemPrompt: [...prompt, text] };
}

/** Telling the model to draw with a tool the user turned off would waste a turn. */
function toolActive(event: AgentStartEvent): boolean {
  const tools = event.systemPromptOptions?.selectedTools;
  return tools === undefined || tools.includes("diagram");
}
