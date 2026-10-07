/**
 * Raw configuration files, for the editor in Settings.
 *
 * `llm.toml` could only be changed in an external editor, followed by
 * "Reload config" in the app. These routes let the app show the file, check a
 * new text with the parser the server loads it with, and save it. A text that
 * does not parse is refused and nothing is written.
 *
 * The files reach the filesystem of the server, so the routes share the guard
 * of the install endpoints: the operator token on a hosted tier, the desktop
 * token under the desktop shell, and an explicit opt-in in production.
 */
import { Hono } from "hono";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseLlmConfig } from "@covel/ai-provider";
import { readRuntimeEnv } from "@covel/shared";
import { parseDesktopConfig } from "@covel/shared/desktop-config";
import { errorBody, listBody, readJsonBody } from "../api-error.js";
import {
  LLM_TOML_STARTER,
  reloadAiStack,
  type AiReloadResult,
  type AiStack,
} from "../ai-setup.js";
import { makeInstallApiGuard } from "./privileged-auth.js";

const MAX_CONTENT_BYTES = 256 * 1024;

interface RawConfigFile {
  readonly name: string;
  readonly path: string;
  /** Throws with the reason when the text is not a valid file of this kind. */
  readonly check: (content: string) => void;
  /** Shown as the starting text while the file does not exist. */
  readonly starter: string;
  /** What a saved file needs before it is in effect. */
  readonly applies: "reload" | "restart";
}

/** Same rule as the config routes: `~/.covel` only under the desktop shell. */
function desktopHome(): string | null {
  const env = readRuntimeEnv();
  if (!env.desktopRest) return null;
  if (env.covelHome) return env.covelHome;
  const candidate = join(homedir(), ".covel");
  return existsSync(candidate) ? candidate : null;
}

function digestOf(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

export function createRawConfigApiRoutes(deps: { ai: AiStack }): Hono {
  const app = new Hono();
  const guard = makeInstallApiGuard();

  const files = (): RawConfigFile[] => {
    const home = desktopHome();
    // The path the server loads, whether or not the file exists yet.
    const llmToml = deps.ai.configSource?.path;
    return [
      ...(llmToml
        ? [
            {
              name: "llm.toml",
              path: llmToml,
              check: (content: string) => void parseLlmConfig(content),
              starter: LLM_TOML_STARTER,
              applies: "reload" as const,
            },
          ]
        : []),
      ...(home
        ? [
            {
              name: "config.toml",
              path: join(home, "config.toml"),
              check: (content: string) => void parseDesktopConfig(content),
              starter: "",
              applies: "restart" as const,
            },
          ]
        : []),
    ];
  };

  const read = (file: RawConfigFile) => {
    const exists = existsSync(file.path);
    const content = exists ? readFileSync(file.path, "utf-8") : "";
    return {
      name: file.name,
      path: file.path,
      exists,
      applies: file.applies,
      // A missing file shows the starter; `digest` is still that of the file.
      content: exists ? content : file.starter,
      digest: digestOf(content),
    };
  };

  // GET /api/config/raw — the files this server lets the app edit.
  app.get("/api/config/raw", guard, (c) =>
    c.json(
      listBody(
        files().map((file) => ({
          name: file.name,
          path: file.path,
          exists: existsSync(file.path),
          applies: file.applies,
        })),
      ),
    ),
  );

  // GET /api/config/raw/:name — the text of one file and the digest to save against.
  app.get("/api/config/raw/:name", guard, (c) => {
    const file = files().find((item) => item.name === c.req.param("name"));
    if (!file) {
      return c.json(
        errorBody("No such configuration file", {
          code: "config_file_unknown",
        }),
        404,
      );
    }
    return c.json(read(file));
  });

  // PUT /api/config/raw/:name — body: { content, baseDigest }.
  // The text is checked first; a text that fails is not written. The file as
  // it was is kept as `<name>.bak`. llm.toml is applied at once.
  app.put("/api/config/raw/:name", guard, async (c) => {
    const file = files().find((item) => item.name === c.req.param("name"));
    if (!file) {
      return c.json(
        errorBody("No such configuration file", {
          code: "config_file_unknown",
        }),
        404,
      );
    }
    const parsed = await readJsonBody<{
      content?: unknown;
      baseDigest?: unknown;
    }>(c);
    if (parsed instanceof Response) return parsed;
    const { content, baseDigest } = parsed.body;
    if (typeof content !== "string" || typeof baseDigest !== "string") {
      return c.json(
        errorBody("content and baseDigest must be strings", {
          code: "config_file_request_invalid",
        }),
        400,
      );
    }
    if (Buffer.byteLength(content, "utf-8") > MAX_CONTENT_BYTES) {
      return c.json(
        errorBody("The file is larger than 256 KiB", {
          code: "config_file_too_large",
        }),
        413,
      );
    }
    try {
      file.check(content);
    } catch (err) {
      return c.json(
        errorBody(err instanceof Error ? err.message : String(err), {
          code: "config_file_invalid",
        }),
        400,
      );
    }

    const exists = existsSync(file.path);
    const before = exists ? readFileSync(file.path, "utf-8") : "";
    // The file changed on disk after the editor loaded it: saving would
    // discard that change without the player seeing it.
    if (digestOf(before) !== baseDigest) {
      return c.json(
        errorBody("The file changed on disk since it was loaded", {
          code: "config_file_changed",
        }),
        409,
      );
    }

    const temporary = `${file.path}.${process.pid}.${randomUUID()}.tmp`;
    let backup: string | undefined;
    try {
      mkdirSync(dirname(file.path), { recursive: true });
      const mode = exists ? statSync(file.path).mode & 0o777 : 0o600;
      if (exists && before !== content) {
        backup = `${file.path}.bak`;
        copyFileSync(file.path, backup);
      }
      writeFileSync(temporary, content, { mode, flag: "wx" });
      renameSync(temporary, file.path);
    } catch (err) {
      try {
        unlinkSync(temporary);
      } catch {
        // Keep the write error.
      }
      throw err;
    }

    const reload: AiReloadResult | undefined =
      file.applies === "reload" ? reloadAiStack(deps.ai) : undefined;
    return c.json({
      ...read(file),
      ...(backup ? { backup } : {}),
      ...(reload ? { reload } : {}),
    });
  });

  return app;
}
