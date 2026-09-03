/**
 * Draws one source under every profile, to compare them by eye.
 *
 * Usage: pnpm preview [source.d2] [output directory]
 */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { D2Cli, PROFILE_NAMES, renderDiagram } from "../packages/d2/dist/index.js";

const [sourceArgument = "test/fixtures/containers.d2", outputArgument = "/tmp/diagram-preview"] =
  process.argv.slice(2);

const source = await readFile(resolve(sourceArgument), "utf8");
const outputDir = resolve(outputArgument);
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const renderer = new D2Cli();
const stem = basename(sourceArgument, ".d2");
let drawing;

for (const profile of PROFILE_NAMES) {
  const rendering = await renderDiagram(
    { source, profile, title: profile, formats: ["svg"], images: true },
    renderer,
  );
  drawing ??= rendering.text;

  const svg = rendering.saved.find((artifact) => artifact.format === "svg");
  await copyFile(svg.path, join(outputDir, `${stem}-${profile}.svg`));
  await rm(svg.path, { force: true });

  const image = rendering.image;
  if (image !== undefined) {
    await copyFile(image.path, join(outputDir, `${stem}-${profile}.png`));
  }
  const size = image === undefined ? "no image" : `${image.widthPx}x${image.heightPx}`;
  const notes = rendering.notes.length === 0 ? "" : `  ${rendering.notes.join(" ")}`;
  console.log(`${profile.padEnd(13)}${size.padEnd(12)}${rendering.renderedAs}${notes}`);
}

// The same for every profile, because D2 draws text in character cells.
await writeFile(join(outputDir, `${stem}.txt`), `${drawing}\n`, "utf8");
console.log(`\n${drawing}\n`);
console.log(`Wrote ${outputDir}. Open it with:  open ${outputDir}`);
