import { primeDisplay } from "./display.js";
import { type GuidanceExtensionApi, registerDiagramGuidance } from "./guidance.js";
import {
  type DiagramExtensionApi,
  primeDiagramDescription,
  registerDiagramTools,
} from "./tools.js";

export default async function piDiagram(
  pi: DiagramExtensionApi & GuidanceExtensionApi,
): Promise<void> {
  await Promise.all([primeDisplay(), primeDiagramDescription()]);
  registerDiagramTools(pi);
  await registerDiagramGuidance(pi);
}
