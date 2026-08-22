import { primeDisplay } from "./display.js";
import { type GuidanceExtensionApi, registerDiagramGuidance } from "./guidance.js";
import { type DiagramExtensionApi, registerDiagramTools } from "./tools.js";

export default async function piDiagram(
  pi: DiagramExtensionApi & GuidanceExtensionApi,
): Promise<void> {
  await primeDisplay();
  registerDiagramTools(pi);
  registerDiagramGuidance(pi);
}
