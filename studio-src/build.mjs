// Builds the Studio into ../studio/app/ (run `npm run build`, or
// `npm run watch` while working on it). The blog serves those files as they are.
import * as esbuild from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "studio", "app");
const watch = process.argv.includes("--watch");

rmSync(out, { recursive: true, force: true });

// KaTeX draws equations; its stylesheet and fonts are loaded on demand.
function copyKatex() {
  const dist = join(here, "node_modules", "katex", "dist");
  mkdirSync(join(out, "katex", "fonts"), { recursive: true });
  copyFileSync(join(dist, "katex.min.css"), join(out, "katex", "katex.min.css"));
  readdirSync(join(dist, "fonts")).filter((f) => f.endsWith(".woff2"))
    .forEach((f) => copyFileSync(join(dist, "fonts", f), join(out, "katex", "fonts", f)));
}

// Every open-source package inside the app, with its license.
function writeLicenses(metafile) {
  const packages = new Map();
  Object.keys(metafile.inputs).forEach((input) => {
    const match = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (match) packages.set(match[1], join(here, "node_modules", match[1]));
  });
  const sections = Array.from(packages).sort(([a], [b]) => a.localeCompare(b)).map(([name, dir]) => {
    const info = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const file = readdirSync(dir).find((f) => /^licen[sc]e(\.md|\.txt)?$/i.test(f));
    const text = file ? readFileSync(join(dir, file), "utf8").trim() : `License: ${info.license}`;
    return `${name} ${info.version} (${info.license})\n${"-".repeat(60)}\n${text}\n`;
  });
  writeFileSync(join(out, "THIRD-PARTY-LICENSES.txt"),
    `The Studio includes these open-source packages:\n\n${sections.join("\n\n")}`);
}

const options = {
  entryPoints: [join(here, "src", "main.js")],
  bundle: true,
  format: "esm",
  splitting: true,
  outdir: out,
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  minify: true,
  target: "es2020",
  legalComments: "none",
  metafile: true,
  logLevel: "info",
  plugins: [{
    name: "studio-files",
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length || !result.metafile) return;
        copyKatex();
        writeLicenses(result.metafile);
      });
    }
  }]
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Watching for changes…");
} else {
  await esbuild.build(options);
  if (!existsSync(join(out, "main.js"))) process.exit(1);
}
