import { primeDisplay } from "./display.js";
import { type GuidanceExtensionApi, registerDiagramGuidance } from "./guidance.js";
import {
  type DiagramExtensionApi,
  type DiagramPreferenceApi,
  primeDiagramDescription,
  registerDiagramPreference,
  registerDiagramTools,
} from "./tools.js";

export default async function piDiagram(
  pi: DiagramExtensionApi & DiagramPreferenceApi & GuidanceExtensionApi,
): Promise<void> {
  await Promise.all([primeDisplay(), primeDiagramDescription()]);
  const renderPreference = await registerDiagramPreference(pi);
  registerDiagramTools(pi, { renderPreference });
  await registerDiagramGuidance(pi);
}
