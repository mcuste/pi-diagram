/** Copies the files the extension ships that TypeScript and esbuild do not emit. */
import { copyFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const plugin = new URL("packages/plugin/", root);

await copyFile(new URL("src/guidance.md", plugin), new URL("dist/guidance.md", plugin));
await copyFile(
  new URL("src/tool-description.md", plugin),
  new URL("dist/tool-description.md", plugin),
);

// npm reads README and LICENSE from the package directory, and both live at the repository root.
await copyFile(new URL("README.md", root), new URL("README.md", plugin));
await copyFile(new URL("LICENSE", root), new URL("LICENSE", plugin));
