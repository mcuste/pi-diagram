import { type DiagramExtensionApi, registerDiagramTools } from "./tools.js";

export default function piDiagram(pi: DiagramExtensionApi): void {
  registerDiagramTools(pi);
}
