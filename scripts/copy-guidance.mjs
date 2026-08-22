import { copyFile } from "node:fs/promises";

await copyFile(
  new URL("../src/guidance.md", import.meta.url),
  new URL("../dist/guidance.md", import.meta.url),
);
