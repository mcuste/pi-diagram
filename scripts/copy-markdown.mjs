import { copyFile } from "node:fs/promises";

await copyFile(
  new URL("../src/guidance.md", import.meta.url),
  new URL("../dist/guidance.md", import.meta.url),
);
await copyFile(
  new URL("../src/tool-description.md", import.meta.url),
  new URL("../dist/tool-description.md", import.meta.url),
);
