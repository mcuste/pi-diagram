/**
 * The prompt block that makes the model draw by itself. The tool description alone gets the tool
 * called when the user asks for a diagram, not when a diagram is the clearer answer.
 */

export const DIAGRAM_GUIDANCE = [
  "Diagrams:",
  "- Call the diagram tool when structure, flow, or relationships are easier to see than to read.",
  "- Draw instead of writing a wall of text: three or more connected parts means a diagram.",
  "- Call the tool before you explain, then write only what the picture does not show.",
  "- Do not repeat the diagram in prose. The user already sees it.",
  "- Never hand-write ASCII art or a Mermaid block. Call the tool.",
  "- Do not draw one fact, a short list, a list of commands, or code that reads better as code.",
  "- Match the diagram to the question:",
  "  - components and their connections: profile architecture",
  "  - the order of messages in time: a sequence diagram, shape: sequence_diagram",
  "  - tables, columns, and keys: profile data, shape: sql_table",
  "  - a hierarchy, such as a call tree or a file layout: profile tree",
  "  - an import, module, or package graph: profile dependency",
  "  - C4 levels, when the reader expects that convention: profile c4",
  "  - a diagram to keep in the repository: profile docs, with save",
  "  - a data flow, a state change, or a request path in an answer: profile explain, the default",
  "- Keep one idea per diagram, about 5 to 15 nodes. Split a bigger picture into more calls.",
  "- Label every edge with what moves or what happens.",
  "- Fix the source and call again when the tool reports an error in it.",
  "- Pass save only when the user asks to keep the diagram.",
].join("\n");

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

export function registerDiagramGuidance(pi: GuidanceExtensionApi): void {
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
  if (typeof prompt === "string") {
    return prompt === "" || prompt.includes(DIAGRAM_GUIDANCE)
      ? undefined
      : { systemPrompt: `${prompt}\n\n${DIAGRAM_GUIDANCE}` };
  }
  if (!Array.isArray(prompt) || prompt.length === 0 || prompt.includes(DIAGRAM_GUIDANCE)) {
    return undefined;
  }
  return { systemPrompt: [...prompt, DIAGRAM_GUIDANCE] };
}

/** Telling the model to draw with a tool the user turned off would waste a turn. */
function toolActive(event: AgentStartEvent): boolean {
  const tools = event.systemPromptOptions?.selectedTools;
  return tools === undefined || tools.includes("diagram");
}
