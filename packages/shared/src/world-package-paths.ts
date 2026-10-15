/**
 * Paths of a world package whose meaning is fixed: the kernel reads its own
 * data there, or the file is the package's manifest, lore, descriptor or a
 * framework art manifest. A plugin's `authoring.source.path` may not name one,
 * so no plugin can take a kernel convention away from a world.
 */
export const KERNEL_WORLD_DATA_PATHS = {
  dimensions: "data/dimensions.yaml",
  lorebook: "data/lorebook.yaml",
  characters: "characters/characters.json",
} as const;

/**
 * Fields of a record in a world's character file that the kernel reads. Any
 * other field holds data for a plugin: the plugin that names that field
 * (`contributes.data.<ns>.authoring.characterField`) receives it.
 */
export const KERNEL_CHARACTER_FIELDS = [
  "id",
  "name",
  "aliases",
  "type",
  "description",
  "fields",
  "version",
  "createdAt",
  "updatedAt",
  "sessionId",
] as const;

export const RESERVED_WORLD_PACKAGE_PATHS: readonly string[] = [
  "world.yaml",
  "WORLD.md",
  "data/world.data.yaml",
  ...Object.values(KERNEL_WORLD_DATA_PATHS),
  "media/gallery.json",
  "media/portraits.json",
  "media/scenes.json",
  "media/gallery/",
];

/**
 * The form two paths are compared in: case-insensitive (a package may sit on
 * a case-insensitive disk), without `.` segments, and with the locale of an
 * edition file removed (`world.zh-CN.yaml` is an edition of `world.yaml`).
 */
function comparable(path: string): string {
  return path
    .toLowerCase()
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/")
    .replace(/\.[a-z]{2,3}(?:-[a-z0-9]+)*(\.[^./]+)$/, "$1");
}

const reserved = RESERVED_WORLD_PACKAGE_PATHS.map((path) => ({
  path: comparable(path),
  directory: path.endsWith("/"),
}));

/** Whether a world-package path is one of `RESERVED_WORLD_PACKAGE_PATHS`. */
export function isReservedWorldPackagePath(path: string): boolean {
  const candidate = comparable(path);
  return reserved.some(
    (item) =>
      candidate === item.path ||
      (item.directory && candidate.startsWith(`${item.path}/`)),
  );
}
