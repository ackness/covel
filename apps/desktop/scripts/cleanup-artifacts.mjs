/**
 * electron-builder afterAllArtifactBuild hook.
 *
 * 我们不接 auto-update，也不需要打包过程的中间产物 / 调试元数据。
 * 这里把 release/electron/ 收敛到「只剩可分发的安装包」：
 *   - 保留：*.dmg / *.zip / *.exe / *.AppImage / *.deb / *.snap / *.rpm / *.pkg
 *   - 删除：*.blockmap、latest*.yml、builder-{debug,effective-config}.{yml,yaml}
 *   - 删除：mac/、mac-arm64/、mac-x64/、win-unpacked/、linux-unpacked/ 等解包目录
 *
 * 钩子签名约定：return Array<string> 追加要发布的 artifact 路径，没有就返回 []。
 */

import path from "node:path";
import fs from "node:fs/promises";

const DROP_FILE_PATTERNS = [
  /\.blockmap$/i,
  /^latest.*\.ya?ml$/i,
  /^builder-debug\.ya?ml$/i,
  /^builder-effective-config\.ya?ml$/i,
];

function isUnpackedDir(name) {
  // electron-builder 解包阶段产物：mac, mac-arm64, mac-x64, win-unpacked,
  // win-ia32-unpacked, linux-unpacked, linux-arm64-unpacked, ...
  if (name === "mac" || /^mac-(arm64|x64|universal)$/.test(name)) return true;
  if (name.endsWith("-unpacked")) return true;
  return false;
}

export default async function cleanupArtifacts(context) {
  const outDir = context?.outDir;
  if (!outDir) return [];

  let entries;
  try {
    entries = await fs.readdir(outDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const removed = [];
  for (const entry of entries) {
    const full = path.join(outDir, entry.name);
    if (entry.isDirectory()) {
      if (isUnpackedDir(entry.name)) {
        await fs.rm(full, { recursive: true, force: true });
        removed.push(entry.name + "/");
      }
      continue;
    }
    if (DROP_FILE_PATTERNS.some((re) => re.test(entry.name))) {
      await fs.rm(full, { force: true });
      removed.push(entry.name);
    }
  }

  if (removed.length > 0) {
    console.log(
      `[cleanup-artifacts] removed ${removed.length} item(s): ${removed.join(", ")}`,
    );
  }
  return [];
}
