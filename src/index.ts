import { primeDisplay } from "./display.js";
import { type GuidanceExtensionApi, registerDiagramGuidance } from "./guidance.js";
import {
  type DiagramExtensionApi,
  type DiagramPreferenceApi,
  registerDiagramPreference,
  registerDiagramTools,
} from "./tools.js";

export default async function piDiagram(
  pi: DiagramExtensionApi & DiagramPreferenceApi & GuidanceExtensionApi,
): Promise<void> {
  await primeDisplay();
  const renderPreference = await registerDiagramPreference(pi);
  registerDiagramTools(pi, { renderPreference });
  await registerDiagramGuidance(pi);
}
