/**
 * Who made a package, and where to find them.
 *
 * `PLUGIN.md`, `world.yaml` and `covel-collection.yaml` declare the same
 * fields, so every list and card shows a package's credits the same way. All
 * of it is display data from the package author: the host shows it and never
 * acts on it, and a link is opened only by the player.
 */
import { z } from "zod";

/** The most links one author block may list. */
export const PACKAGE_LINK_LIMIT = 6;

/** Key under a world record's `metadata` that keeps its version and credits. */
export const WORLD_PACKAGE_INFO_KEY = "packageInfo";

/** Plain text or a locale map; each text has at most `max` characters. */
function displayText(max: number) {
  const text = z.string().min(1).max(max);
  return z.union([text, z.record(z.string(), text)]);
}

/**
 * True for a link a player may open: `https`, with a host and no credentials.
 * The host opens a link in the player's browser, so a `javascript:`, `file:`
 * or `http:` address must not pass, and `user:password@` hides the real host.
 */
export function isPackageLinkUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname !== "" &&
    url.username === "" &&
    url.password === ""
  );
}

export const packageLinkUrlSchema = z
  .string()
  .max(2048)
  .regex(/^https:\/\/\S+$/, { message: "must be an https:// address" })
  .refine(isPackageLinkUrl, {
    message: "must be an https:// address without a user name or password",
  });

export const packageLinkSchema = z.strictObject({
  label: displayText(40).meta({
    description: "Text of the link.",
    examples: ["Discord"],
  }),
  url: packageLinkUrlSchema.meta({
    description:
      "Address of the link. `https` only. The player sees the full address and confirms before it opens.",
    examples: ["https://example.com/community"],
  }),
});

export const packageAuthorSchema = z
  .strictObject({
    name: z
      .string()
      .min(1)
      .max(80)
      .meta({
        description:
          "Name of the person or team. Shown as written in every language.",
        examples: ["Jane Doe"],
      }),
    url: packageLinkUrlSchema
      .meta({
        description: "The author's own page. `https` only.",
        examples: ["https://example.com"],
      })
      .optional(),
    about: displayText(500)
      .describe(
        "A short message from the author to players: who they are, what else they make, how to support them. Plain text.",
      )
      .optional(),
    links: z
      .array(packageLinkSchema)
      .max(PACKAGE_LINK_LIMIT)
      .describe(
        `Links the author wants players to see, such as a community, a support page or other work. At most ${PACKAGE_LINK_LIMIT}.`,
      )
      .optional(),
  })
  .describe(
    "Who made the package. Shown on the package's cards before play, never during play.",
  );

/** The credit fields a manifest declares; spread them into its object schema. */
export const packageCreditFields = {
  author: packageAuthorSchema.optional(),
  license: z
    .string()
    .min(1)
    .max(64)
    .meta({
      description:
        "License of the package: an SPDX identifier or a short name.",
      examples: ["MIT", "CC-BY-4.0"],
    })
    .optional(),
  homepage: packageLinkUrlSchema
    .meta({
      description:
        "Page of the package itself, such as its repository or documentation. `https` only.",
      examples: ["https://example.com/my-package"],
    })
    .optional(),
};

/** What a list or card shows about a package: its version and its credits. */
export const packageInfoSchema = z.strictObject({
  version: z.string().optional(),
  ...packageCreditFields,
});

export type PackageLink = z.infer<typeof packageLinkSchema>;
export type PackageAuthor = z.infer<typeof packageAuthorSchema>;
export type PackageInfo = z.infer<typeof packageInfoSchema>;

/** The version and credits of a manifest; undefined when it declares none. */
export function packageInfoOf(
  manifest: Readonly<Record<string, unknown>>,
): PackageInfo | undefined {
  const parsed = packageInfoSchema.safeParse({
    version: manifest.version,
    author: manifest.author,
    license: manifest.license,
    homepage: manifest.homepage,
  });
  if (!parsed.success) return undefined;
  const info = Object.fromEntries(
    Object.entries(parsed.data).filter(([, value]) => value !== undefined),
  ) as PackageInfo;
  return Object.keys(info).length > 0 ? info : undefined;
}
