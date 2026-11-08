// Standalone client build: the same Bun.build configuration the Muse
// space SDK uses for this app (see vendor/space-sdk/dist/build.js —
// production NODE_ENV, assets/[name]-[hash] naming, tailwind plugin),
// minus the hosted platform's publish guard. Output: client/dist.

import { rm } from "node:fs/promises";
import { basename } from "node:path";
import tailwindPlugin from "bun-plugin-tailwind";

const OUTDIR = "./client/dist";

await rm(OUTDIR, { force: true, recursive: true });
const result = await Bun.build({
  entrypoints: ["./client/index.html"],
  outdir: OUTDIR,
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  naming: {
    asset: "assets/[name]-[hash].[ext]",
    chunk: "assets/[name]-[hash].[ext]",
    entry: "[name].[ext]",
  },
  plugins: [tailwindPlugin],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("client build failed; see logged diagnostics");
}

// Bun emits imported-asset URLs as bare ./<name>-<hash>.<ext>; re-prefix
// them to ./assets/... so they resolve inside client/dist (same fix the
// SDK build applies).
const assetFiles = result.outputs
  .filter((output) => output.kind === "asset")
  .map((output) => basename(output.path));
for (const output of result.outputs) {
  if (!/\.(js|css|html)$/.test(output.path)) continue;
  let text = await output.text();
  let changed = false;
  for (const name of assetFiles) {
    const bare = `./${name}`;
    if (text.includes(bare)) {
      text = text.split(bare).join(`./assets/${name}`);
      changed = true;
    }
  }
  if (changed) await Bun.write(output.path, text);
}
console.log(`client built -> ${OUTDIR}`);
