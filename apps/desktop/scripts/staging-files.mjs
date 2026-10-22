import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isBuiltin } from "node:module";

/** Own staged bytes before build caches or packaging tools can overwrite them. */
export function detachStagingHardlinks(directory) {
  let detached = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      detached += detachStagingHardlinks(file);
    } else if (entry.isFile() && fs.statSync(file).nlink > 1) {
      // pnpm deploy can hardlink workspace files even in legacy mode. Replacing
      // only the staging directory entry preserves source bytes and permissions.
      const temporary = path.join(directory, `.stage-copy-${randomUUID()}`);
      try {
        fs.copyFileSync(file, temporary, fs.constants.COPYFILE_EXCL);
        fs.renameSync(temporary, file);
        detached++;
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    }
    // Do not follow symlinks into a workspace or package store.
  }
  return detached;
}

/**
 * A gallery PNG that has a WebP of the same name beside it. The app shows the
 * WebP (`webFilename` in `media/gallery.json`); the PNG is the original the
 * repository keeps, and no code reads it.
 */
export function isGalleryOriginal(file) {
  return (
    /[\\/]media[\\/]gallery[\\/][^\\/]+\.png$/i.test(file) &&
    fs.existsSync(file.replace(/\.png$/i, ".webp"))
  );
}

const declarationPackages = new Set([
  "@hono/node-server",
  "@opentelemetry/api",
  "@types/node",
  "@types/yauzl",
  "drizzle-orm",
  "esbuild",
  "fast-deep-equal",
  "fast-uri",
  "fsevents",
  "gray-matter",
  "hono",
  "json-schema-traverse",
  "postgres",
  "smol-toml",
  "sqlite-vec",
  "tsx",
  "undici",
  "undici-types",
  "yaml",
  "zod",
]);
const developmentPaths = [
  "fast-uri/test",
  "fast-uri/benchmark",
  "json-schema-traverse/spec",
  "sprintf-js/test",
  "sprintf-js/demo",
  "pend/test.js",
  "zod/src/v3/tests",
  "zod/src/v4/core/tests",
  "zod/src/v4/mini/tests",
  "zod/src/v4/classic/tests",
];

function inside(root, filename) {
  const relative = path.relative(root, filename);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function walkFiles(directory, visit) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (visit(filename, entry) !== false && entry.isDirectory()) {
      walkFiles(filename, visit);
    }
  }
}

/**
 * Prune only reviewed dependency locations, after compilation and detachment.
 * Authored plugins/worlds and native target packages are never prune candidates.
 */
export function pruneStagedServer(serverRoot, compiledSources) {
  const requestedRoot = path.resolve(serverRoot);
  const root = fs.realpathSync(requestedRoot);
  // Compare real link targets and removal candidates in the same path domain.
  // Rebase caller paths without resolving inner links: a link through .pnpm
  // must still be rejected even if its final target is a retained file.
  const stagedPath = (filename) => {
    const absolute = path.resolve(filename);
    return inside(requestedRoot, absolute)
      ? path.join(root, path.relative(requestedRoot, absolute))
      : absolute;
  };
  const modules = path.join(root, "node_modules");
  const removals = new Set([path.join(modules, ".pnpm")]);
  const frameworkRoots = [root];
  const workspace = path.join(modules, "@covel");
  for (const entry of fs.readdirSync(workspace, { withFileTypes: true })) {
    if (entry.isDirectory())
      frameworkRoots.push(path.join(workspace, entry.name));
  }
  for (const compiledSource of compiledSources) {
    const source = stagedPath(compiledSource);
    if (
      !frameworkRoots.some((pkg) => inside(path.join(pkg, "src"), source)) ||
      !source.endsWith(".ts") ||
      !fs.statSync(source.replace(/\.ts$/, ".js")).isFile()
    ) {
      throw new Error(`Cannot prune uncompiled framework source: ${source}`);
    }
    removals.add(source);
  }
  for (const packageRoot of frameworkRoots) {
    for (const directory of ["tests", ".turbo"]) {
      removals.add(path.join(packageRoot, directory));
    }
    for (const directory of ["src", "dist"]) {
      const target = path.join(packageRoot, directory);
      if (!fs.existsSync(target)) continue;
      walkFiles(target, (filename, entry) => {
        if (
          entry.isFile() &&
          (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filename) ||
            /\.d\.[cm]?ts$/.test(filename))
        ) {
          removals.add(filename);
        }
      });
    }
  }
  for (const name of declarationPackages) {
    const target = path.join(modules, name);
    if (!fs.existsSync(target)) continue;
    // Never descend through a package symlink into pnpm's or a host's store.
    if (!fs.lstatSync(target).isDirectory()) continue;
    walkFiles(target, (filename, entry) => {
      if (entry.name === "node_modules") return false;
      if (entry.isFile() && /\.d\.[cm]?ts$/.test(filename))
        removals.add(filename);
    });
  }
  for (const relative of developmentPaths) {
    removals.add(path.join(modules, relative));
  }

  // Validate the complete retained graph before the first deletion. A different
  // pnpm layout must fail rather than silently package dangling/host-only links.
  const removed = (filename) => {
    for (
      let current = filename;
      inside(root, current);
      current = path.dirname(current)
    ) {
      if (removals.has(current)) return true;
      if (current === root) break;
    }
    return false;
  };
  walkFiles(root, (filename, entry) => {
    if (removed(filename)) return false;
    if (entry.isSymbolicLink()) {
      const target = fs.realpathSync(filename);
      const immediate = stagedPath(
        path.resolve(path.dirname(filename), fs.readlinkSync(filename)),
      );
      if (!inside(root, target) || removed(target) || removed(immediate)) {
        throw new Error(
          `Staged runtime link depends on removed or external files: ${filename}`,
        );
      }
    } else if (
      entry.isFile() &&
      (entry.name === "package.json" ||
        inside(path.join(modules, ".bin"), filename) ||
        (inside(modules, filename) && /\.[cm]?js$/.test(filename)))
    ) {
      // Hoisted wrappers, import maps and explicit runtime paths may refer to
      // the store without a symlink. Ordinary Node lookup never searches .pnpm.
      if (/\.pnpm[/\\]/.test(fs.readFileSync(filename, "utf8"))) {
        throw new Error(
          `Staged runtime resolution still references .pnpm: ${filename}`,
        );
      }
    }
  });
  for (const filename of removals) {
    fs.rmSync(filename, { recursive: true, force: true });
  }
}

/** All imports left in an emitted desktop bundle must be platform-provided. */
export function assertDesktopBundle(metafile) {
  for (const [filename, output] of Object.entries(metafile.outputs)) {
    for (const imported of output.imports) {
      if (imported.path !== "electron" && !isBuiltin(imported.path)) {
        throw new Error(
          `Desktop bundle ${filename} still imports ${imported.path}`,
        );
      }
    }
  }
}

const bundledNotices = {
  zod: ["LICENSE"],
  undici: ["LICENSE", "lib/milo/LICENSE.md"],
  "smol-toml": ["LICENSE"],
  "@covel/plugin-handlers-utils": ["LICENSE"],
};

/** Retained sidecar notices must cover the exact bytes/versions bundled in main. */
export function verifyBundledNotices(metafiles, workingDirectory, serverRoot) {
  const visited = new Set();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      let directory = path.dirname(path.resolve(workingDirectory, input));
      while (directory !== path.dirname(directory)) {
        // An earlier walk already checked this directory and its notice owner.
        if (visited.has(directory)) break;
        visited.add(directory);
        const manifestFile = path.join(directory, "package.json");
        if (fs.existsSync(manifestFile)) {
          const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
          const notices = bundledNotices[manifest.name];
          if (notices) {
            const staged = path.join(serverRoot, "node_modules", manifest.name);
            const stagedManifest = JSON.parse(
              fs.readFileSync(path.join(staged, "package.json"), "utf8"),
            );
            if (manifest.version !== stagedManifest.version) {
              throw new Error(
                `Bundled/staged notice version mismatch: ${manifest.name}`,
              );
            }
            for (const notice of notices) {
              const original = fs.readFileSync(path.join(directory, notice));
              if (
                !original.length ||
                !original.equals(fs.readFileSync(path.join(staged, notice)))
              ) {
                throw new Error(
                  `Bundled/staged notice mismatch: ${manifest.name}/${notice}`,
                );
              }
            }
            break;
          }
        }
        directory = path.dirname(directory);
      }
    }
  }
}
