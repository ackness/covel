import { app, BrowserWindow } from "electron";
import { readFile, writeFile } from "node:fs/promises";

// Run from the desktop package with its pinned Electron:
// pnpm --filter @covel/desktop exec electron scripts/generate-portable-splash.mjs
// Commit the resulting BMP: NSIS consumes it directly, not the SVG or Electron.
const source = new URL("../resources/portable-splash.svg", import.meta.url);
const target = new URL("../resources/portable-splash.bmp", import.meta.url);
app.commandLine.appendSwitch("force-device-scale-factor", "1");
// Electron waits for ESM entry evaluation before emitting ready. Do not await
// whenReady at module scope: that makes module evaluation wait on itself.
void app.whenReady().then(async () => {
  let window;
  let exitCode = 0;
  try {
    const svg = await readFile(source, "utf8");
    window = new BrowserWindow({
      width: 640,
      height: 300,
      useContentSize: true,
      show: false,
      frame: false,
      webPreferences: {
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    await window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(`<style>html,body{margin:0;overflow:hidden}</style>${svg}`)}`,
    );
    await window.webContents.executeJavaScript(
      "document.fonts.ready.then(() => true)",
    );
    // Capture a normal compositor surface, not an early offscreen paint event
    // (which can carry an empty image). Keep the generator window hidden.
    let captureTimer;
    const image = await Promise.race([
      window.webContents.capturePage(undefined, { stayHidden: true }),
      new Promise((_resolve, reject) => {
        captureTimer = setTimeout(() => {
          reject(new Error("Portable splash capture exceeded 15 seconds"));
        }, 15_000);
      }),
    ]).finally(() => clearTimeout(captureTimer));
    const { width, height } = image.getSize();
    if (width !== 640 || height !== 300) {
      throw new Error(`Unexpected splash size: ${width}x${height}`);
    }
    const pixels = image.toBitmap();
    if (pixels.length !== width * height * 4) {
      throw new Error(
        "Splash bitmap must have one BGRA pixel per source pixel",
      );
    }
    const stride = (width * 3 + 3) & ~3;
    const bitmap = Buffer.alloc(54 + stride * height);
    bitmap.write("BM");
    bitmap.writeUInt32LE(bitmap.length, 2);
    bitmap.writeUInt32LE(54, 10);
    bitmap.writeUInt32LE(40, 14);
    bitmap.writeInt32LE(width, 18);
    bitmap.writeInt32LE(height, 22);
    bitmap.writeUInt16LE(1, 26);
    bitmap.writeUInt16LE(24, 28);
    bitmap.writeUInt32LE(stride * height, 34);
    // Electron supplies BGRA; uncompressed BMP uses bottom-up BGR scanlines.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const input = (y * width + x) * 4;
        const output = 54 + (height - 1 - y) * stride + x * 3;
        pixels.copy(bitmap, output, input, input + 3);
      }
    }
    await writeFile(target, bitmap);
    console.log(`Wrote ${target.pathname}: ${width}x${height}, 24-bit BMP`);
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    window?.destroy();
    app.exit(exitCode);
  }
});
