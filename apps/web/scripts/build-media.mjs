#!/usr/bin/env node
/**
 * build-media — generate the homepage demo assets from a source video or GIF.
 *
 * Outputs (always overwrites):
 *   apps/web/public/media/demo.mp4    1280-wide H.264, no audio
 *   apps/web/public/media/demo-poster.jpg  first-frame, 1280-wide
 *   .assets/images/demo.gif           README-friendly 960-wide gif (palette-tuned)
 *
 * Usage:
 *   pnpm --filter @covel/web build:media                # uses .assets/demo.dev1.mp4 if present, else .assets/images/demo.gif
 *   pnpm --filter @covel/web build:media path/to/clip.mp4
 *   pnpm --filter @covel/web build:media path/to/clip.mp4 --speed 3
 *
 * Flags:
 *   --speed N   speed up output N× (default 1)
 *   --width N   output mp4 width (default 1280)
 *   --gif-width N  output gif width (default 960)
 *
 * Requires ffmpeg in PATH.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const PUBLIC_MEDIA = resolve(HERE, "../public/media");
const README_GIF = resolve(REPO_ROOT, ".assets/images/demo.gif");

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const SPEED = Number(flag("--speed", "1")) || 1;
const WIDTH = Number(flag("--width", "1280")) || 1280;
const GIF_WIDTH = Number(flag("--gif-width", "960")) || 960;

// First positional non-flag is the source path
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const sourceArg = positional[0];

const candidates = [
  sourceArg && resolve(process.cwd(), sourceArg),
  resolve(REPO_ROOT, ".assets/demo.dev1.mp4"),
  resolve(REPO_ROOT, ".assets/demo.dev0.mp4"),
  resolve(REPO_ROOT, ".assets/images/demo.gif"),
].filter(Boolean);

const source = candidates.find((p) => existsSync(p));

if (!source) {
  console.error("[build-media] no source found. Tried:");
  for (const p of candidates) console.error(`  - ${p}`);
  process.exit(1);
}

mkdirSync(PUBLIC_MEDIA, { recursive: true });

const outVideo = resolve(PUBLIC_MEDIA, "demo.mp4");
const outPoster = resolve(PUBLIC_MEDIA, "demo-poster.jpg");

console.log(`[build-media] source: ${source}`);
console.log(`[build-media] speed:  ${SPEED}×, width: ${WIDTH}, gif width: ${GIF_WIDTH}`);

// 1) MP4 — speed-up via setpts (no audio: -an)
const speedFilter = SPEED === 1 ? "" : `,setpts=${(1 / SPEED).toFixed(4)}*PTS`;
const mp4Vf = `scale=${WIDTH}:-2:flags=lanczos${speedFilter}`;

run("ffmpeg", [
  "-y",
  "-i", source,
  "-an",
  "-movflags", "+faststart",
  "-pix_fmt", "yuv420p",
  "-vf", mp4Vf,
  "-c:v", "libx264",
  "-preset", "slow",
  "-crf", "26",
  outVideo,
]);
report("demo.mp4", outVideo);

// 2) Poster — first frame at output width
run("ffmpeg", [
  "-y",
  "-i", source,
  "-frames:v", "1",
  "-vf", `scale=${WIDTH}:-2:flags=lanczos`,
  "-q:v", "3",
  outPoster,
]);
report("demo-poster.jpg", outPoster);

// 3) README gif — two-pass with palette for sharper colors at small size
const palette = resolve(PUBLIC_MEDIA, ".palette.png");
const gifVf = `fps=15,scale=${GIF_WIDTH}:-2:flags=lanczos${speedFilter}`;

run("ffmpeg", [
  "-y",
  "-i", source,
  "-vf", `${gifVf},palettegen=stats_mode=diff`,
  palette,
]);
run("ffmpeg", [
  "-y",
  "-i", source,
  "-i", palette,
  "-lavfi", `${gifVf} [v]; [v][1:v] paletteuse=dither=bayer:bayer_scale=4`,
  README_GIF,
]);

try {
  // tidy up the intermediate palette
  execFileSync("rm", ["-f", palette]);
} catch {
  /* ignore */
}
report("demo.gif", README_GIF);

console.log("[build-media] done");

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
  } catch (err) {
    console.error(`[build-media] ${cmd} failed`);
    process.exit(typeof err.status === "number" ? err.status : 1);
  }
}

function report(name, path) {
  try {
    const kb = (statSync(path).size / 1024).toFixed(0);
    console.log(`[build-media]   ${name}: ${kb} KB`);
  } catch {
    /* ignore */
  }
}
