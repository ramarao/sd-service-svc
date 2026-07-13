// Build the town Worker into a bundle the control plane can upload via the CF API.
// A Worker can't bundle code at runtime, so we pre-bundle here and drop the result
// under apps/admin/public/town-dist/ (served to the admin worker via its ASSETS binding).
//
//   node scripts/build-town-bundle.mjs [apps/<town>]   (default: apps/demo)
//
// Produces in apps/admin/public/town-dist/:
//   worker.js             the bundled town Worker (ESM)
//   schema.sql            the town DB schema (structure only; content seeded post-deploy)
//   assets/…              the town's static SPA files
//   assets-manifest.json  { "/path": { hash, size, contentType } } for the CF assets upload
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const townDir = process.argv[2] ? path.resolve(root, process.argv[2]) : path.join(root, "apps/demo");
const outDir = path.join(root, "apps/admin/public/town-dist");
const tmp = path.join(root, ".town-build-tmp");

const CT = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon", ".png": "image/png" };

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "assets"), { recursive: true });

// 1) Bundle the town Worker with wrangler (esbuild under the hood).
console.log(`Bundling ${path.relative(root, townDir)} …`);
fs.rmSync(tmp, { recursive: true, force: true });
execFileSync("npx", ["wrangler", "deploy", "-c", path.join(townDir, "wrangler.jsonc"), "--dry-run", "--outdir", tmp], { cwd: root, stdio: "inherit" });
const entry = fs.existsSync(path.join(tmp, "index.js")) ? "index.js" : fs.readdirSync(tmp).find((f) => f.endsWith(".js"));
fs.copyFileSync(path.join(tmp, entry), path.join(outDir, "worker.js"));

// 2) Schema.
fs.copyFileSync(path.join(townDir, "schema.sql"), path.join(outDir, "schema.sql"));

// 3) Static assets + manifest.
const publicDir = path.join(townDir, "public");
const manifest = {};
const walk = (dir, base = "") => {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = base + "/" + name;
    if (fs.statSync(abs).isDirectory()) walk(abs, rel);
    else {
      const bytes = fs.readFileSync(abs);
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
      const dest = path.join(outDir, "assets", rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes);
      manifest[rel] = { hash, size: bytes.length, contentType: CT[path.extname(name)] || "application/octet-stream" };
    }
  }
};
walk(publicDir);
fs.writeFileSync(path.join(outDir, "assets-manifest.json"), JSON.stringify(manifest, null, 2));
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`✓ town bundle → ${path.relative(root, outDir)} (${Object.keys(manifest).length} assets, worker ${(fs.statSync(path.join(outDir, "worker.js")).size / 1024).toFixed(0)} KiB)`);
