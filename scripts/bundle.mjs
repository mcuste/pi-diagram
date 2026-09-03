/**
 * Bundles the extension into one file so the published package carries the private workspace
 * packages inside it. Third-party packages stay external and are installed as dependencies.
 */
import { build } from "esbuild";

const plugin = new URL("../packages/plugin/", import.meta.url);

await build({
  entryPoints: [new URL("src/index.ts", plugin).pathname],
  outfile: new URL("dist/extension.js", plugin).pathname,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  external: [
    "@resvg/resvg-js",
    "@xmldom/xmldom",
    "typebox",
    "@earendil-works/pi-tui",
    "@oh-my-pi/pi-tui",
  ],
  logLevel: "warning",
});
