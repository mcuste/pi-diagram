import { type GuidanceExtensionApi, registerDiagramGuidance } from "./guidance.js";
import { type DiagramExtensionApi, registerDiagramTools } from "./tools.js";

export default function piDiagram(pi: DiagramExtensionApi & GuidanceExtensionApi): void {
  registerDiagramTools(pi);
  registerDiagramGuidance(pi);
}
