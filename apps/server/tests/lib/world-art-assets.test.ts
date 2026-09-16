import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectPng } from "../../../../scripts/lib/png-image-validation.mjs";

interface MediaRef {
  id: string;
  mime: string;
  size: number;
}

interface PortraitManifest {
  defaults: { size: string };
  style: { background?: string };
  characters: Array<{
    characterId: string;
    filename: string;
    visual?: { id?: string };
    variants?: Array<{ id: string; filename: string }>;
  }>;
}

interface Presence {
  characterId: string;
  avatar: MediaRef;
  sprite: MediaRef;
  visuals?: {
    defaultVariant: string;
    variants: Array<{ id: string; sprite: MediaRef }>;
  };
}

const worldsRoot = path.resolve(import.meta.dirname, "../../../../worlds");
const worlds = (await readdir(worldsRoot)).filter((world) =>
  existsSync(path.join(worldsRoot, world, "world.yaml")),
);

async function readJson<T>(filename: string): Promise<T> {
  return JSON.parse(await readFile(filename, "utf8")) as T;
}

async function imageRef(filename: string, size: string, transparent = false) {
  const bytes = await readFile(filename);
  const image = inspectPng(bytes);
  expect(`${image.width}x${image.height}`, filename).toBe(size);
  if (transparent) expect(image.hasTransparency, filename).toBe(true);
  return {
    id: createHash("sha256").update(bytes).digest("hex"),
    mime: "image/png",
    size: bytes.length,
  };
}

describe.each(worlds)("shipped art: %s", (world) => {
  const mediaDir = path.join(worldsRoot, world, "media");

  const portraitManifestPath = path.join(mediaDir, "portraits.json");
  it.skipIf(!existsSync(portraitManifestPath))(
    "keeps portrait dimensions and every locale's media references in sync",
    async () => {
      const manifestPath = portraitManifestPath;
      const manifest = await readJson<PortraitManifest>(manifestPath);
      const locales = (await readdir(mediaDir)).filter((name) =>
        /^presence(?:\.[\w-]+)?\.json$/.test(name),
      );
      expect(locales).toContain("presence.json");
      for (const locale of locales) {
        const records = await readJson<Presence[]>(path.join(mediaDir, locale));
        expect(records.map((record) => record.characterId).sort()).toEqual(
          manifest.characters.map((character) => character.characterId).sort(),
        );
        for (const character of manifest.characters) {
          const record = records.find(
            (entry) => entry.characterId === character.characterId,
          )!;
          const expected = await imageRef(
            path.join(mediaDir, "portraits", character.filename),
            manifest.defaults.size,
            manifest.style.background === "transparent",
          );
          const label = `${world}/${locale}/${character.characterId}`;
          expect(record.avatar, label).toEqual(expected);
          expect(record.sprite, label).toEqual(expected);
          const variants = [
            {
              id: character.visual?.id ?? "default",
              filename: character.filename,
            },
            ...(character.variants ?? []),
          ];
          if (record.visuals || character.variants?.length) {
            expect(record.visuals?.defaultVariant, label).toBe(variants[0].id);
            expect(
              record.visuals?.variants.map((variant) => variant.id).sort(),
              label,
            ).toEqual(variants.map((variant) => variant.id).sort());
            for (const variant of variants) {
              expect(
                record.visuals?.variants.find(
                  (entry) => entry.id === variant.id,
                )?.sprite,
                `${label}/${variant.id}`,
              ).toEqual(
                await imageRef(
                  path.join(mediaDir, "portraits", variant.filename),
                  manifest.defaults.size,
                  manifest.style.background === "transparent",
                ),
              );
            }
          }
        }
      }
    },
  );

  const sceneManifestPath = path.join(mediaDir, "scenes.json");
  it.skipIf(!existsSync(sceneManifestPath))(
    "keeps authored scene variants, style and hashes aligned with their registry",
    async () => {
      const manifestPath = sceneManifestPath;
      const manifest = await readJson<{
        defaults: { size: string };
        style: Record<string, unknown>;
        scenes: Array<{ id: string; name: string; locationRef: string }>;
      }>(manifestPath);
      const registry = await readJson<{
        style: Record<string, unknown>;
        scenes: Array<{
          sceneId: string;
          name: string;
          locationRef: string;
          day: MediaRef;
          night: MediaRef | null;
        }>;
      }>(path.join(mediaDir, "scenes.registry.json"));
      expect(registry.style).toEqual(manifest.style);
      expect(registry.scenes.map((scene) => scene.sceneId).sort()).toEqual(
        manifest.scenes.map((scene) => scene.id).sort(),
      );
      for (const scene of manifest.scenes) {
        const entry = registry.scenes.find(
          (item) => item.sceneId === scene.id,
        )!;
        expect(entry.name).toBe(scene.name);
        expect(entry.locationRef).toBe(scene.locationRef);
        for (const variant of ["day", "night"] as const) {
          const filename = path.join(
            mediaDir,
            "scenes",
            `${scene.id}-${variant}.png`,
          );
          if (variant === "night" && !existsSync(filename)) {
            expect(entry.night).toBeNull();
            continue;
          }
          expect(entry[variant], filename).toEqual(
            await imageRef(filename, manifest.defaults.size),
          );
        }
      }
    },
  );
});
