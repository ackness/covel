#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


TEMPLATES = {
    "command",
    "context-only",
    "interaction-choice",
    "mechanic-dice",
    "media-image",
    "media-audio",
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Scaffold a covel extension/package.")
    parser.add_argument("--repo-root", required=True, help="Path to the covel repository root")
    parser.add_argument("--name", required=True, help="Extension/package folder name")
    parser.add_argument("--description", required=True, help="Human-readable package description")
    parser.add_argument("--template", required=True, choices=sorted(TEMPLATES))
    parser.add_argument("--kind", help="Override package kind")
    parser.add_argument("--force", action="store_true", help="Allow writing into an existing extension directory")
    args = parser.parse_args()

    repo_root = Path(args.repo_root).expanduser().resolve()
    extensions_root = repo_root / "extensions"
    package_root = extensions_root / args.name

    if not extensions_root.is_dir():
      raise SystemExit(f"extensions/ directory not found under repo root: {repo_root}")

    if package_root.exists() and not args.force:
      raise SystemExit(f"Target already exists: {package_root} (use --force to allow it)")

    package_root.mkdir(parents=True, exist_ok=True)
    files = build_template(
      name=args.name,
      description=args.description,
      template=args.template,
      kind=args.kind
    )

    for relative_path, content in files.items():
      absolute_path = package_root / relative_path
      absolute_path.parent.mkdir(parents=True, exist_ok=True)
      absolute_path.write_text(content, encoding="utf-8")

    print(json.dumps({
      "ok": True,
      "packageRoot": str(package_root),
      "template": args.template,
      "files": sorted(files.keys())
    }, ensure_ascii=False, indent=2))
    return 0


def build_template(*, name: str, description: str, template: str, kind: str | None) -> dict[str, str]:
    package_kind = kind or default_kind(template)
    files: dict[str, str] = {
      "SKILL.md": skill_markdown(name, description, template),
    }

    contributes = {
      "contextProviders": [],
      "commands": [],
      "hooks": [],
      "capabilities": [],
      "blockTypes": [],
      "renderers": [],
      "artifactTypes": [],
    }
    settings: list[dict] = []
    state: list[dict] = []
    permissions: list[str] = ["read:session"]
    scopes = ["session"]

    if template == "command":
      contributes["commands"].append({
        "name": name.replace("_", "-"),
        "description": description,
        "argsSchema": f"schemas/commands/{name}.args.json",
        "entry": f"server/commands/{name}.ts",
        "resume": False,
      })
      files[f"schemas/commands/{name}.args.json"] = object_schema()
      files[f"server/commands/{name}.ts"] = command_module(name, description)

    elif template == "context-only":
      permissions = ["read:world", "read:session"]
      scopes = ["world", "session"]
      contributes["contextProviders"].append({
        "id": f"{name}.context",
        "entry": "server/context.ts",
        "reads": ["world", "session"],
        "writes": [],
      })
      files["server/context.ts"] = context_provider_module(name, description)

    elif template == "interaction-choice":
      permissions.extend(["emit:block"])
      contributes["commands"].append({
        "name": name.replace("_", "-"),
        "description": description,
        "argsSchema": f"schemas/commands/{name}.args.json",
        "entry": f"server/commands/{name}.ts",
        "resume": False,
      })
      contributes["capabilities"].append({
        "id": f"{name}.resume-choice",
        "type": "workflow",
        "entry": "server/capabilities/resume-choice.ts",
        "inputSchema": "schemas/capabilities/resume-choice.input.json",
        "outputSchema": "schemas/capabilities/resume-choice.output.json",
      })
      contributes["blockTypes"].append({
        "type": "choice_set",
        "dataSchema": "schemas/blocks/choice-set.data.json",
        "responseSchema": "schemas/blocks/choice-set.response.json",
        "resume": {"handler": f"{name}.resume-choice"},
        "ui": {"component": "schema", "renderer": "choice-set"},
      })
      files[f"schemas/commands/{name}.args.json"] = object_schema()
      files["schemas/capabilities/resume-choice.input.json"] = object_schema()
      files["schemas/capabilities/resume-choice.output.json"] = object_schema()
      files["schemas/blocks/choice-set.data.json"] = choice_data_schema()
      files["schemas/blocks/choice-set.response.json"] = choice_response_schema()
      files[f"server/commands/{name}.ts"] = choice_command_module(name)
      files["server/capabilities/resume-choice.ts"] = resume_capability_module(name)

    elif template == "mechanic-dice":
      permissions.extend(["emit:block", "write:package-state", "read:package-state", "invoke:builtin"])
      contributes["capabilities"].append({
        "id": f"{name}.resolve-check",
        "type": "workflow",
        "entry": "server/capabilities/resolve-check.ts",
        "inputSchema": "schemas/capabilities/resolve-check.input.json",
        "outputSchema": "schemas/capabilities/resolve-check.output.json",
      })
      contributes["blockTypes"].append({
        "type": "dice_result",
        "dataSchema": "schemas/blocks/dice-result.data.json",
        "responseSchema": "schemas/blocks/dice-result.response.json",
        "resume": {"handler": f"{name}.acknowledge-result"},
        "ui": {"component": "schema", "renderer": "dice-result"},
      })
      state.append({
        "collection": "roll_history",
        "scope": "session",
        "schema": "schemas/state/roll-history.json",
      })
      files["schemas/capabilities/resolve-check.input.json"] = object_schema()
      files["schemas/capabilities/resolve-check.output.json"] = object_schema()
      files["schemas/blocks/dice-result.data.json"] = object_schema()
      files["schemas/blocks/dice-result.response.json"] = object_schema()
      files["schemas/state/roll-history.json"] = object_schema()
      files["server/capabilities/resolve-check.ts"] = generic_capability_module(name, "resolve-check")

    elif template == "media-image":
      permissions.extend(["emit:block", "emit:artifact", "invoke:model", "invoke:job", "read:artifacts"])
      contributes["hooks"].append({
        "id": f"{name}.after-narration",
        "phase": "afterNarration",
        "trigger": {"type": "event", "event": "narration.completed"},
        "entry": "server/hooks/after-narration.ts",
      })
      contributes["artifactTypes"].append({
        "type": "scene-image",
        "kind": "image",
        "mediaType": "image/png",
      })
      contributes["blockTypes"].append({
        "type": "image_card",
        "dataSchema": "schemas/blocks/image-card.data.json",
        "responseSchema": "schemas/blocks/image-card.response.json",
        "ui": {"component": "schema", "renderer": "image-card"},
      })
      settings.append({
        "key": f"{name}.autoGenerate",
        "type": "boolean",
        "default": False,
        "scope": "world",
      })
      files["schemas/blocks/image-card.data.json"] = object_schema()
      files["schemas/blocks/image-card.response.json"] = object_schema()
      files["server/hooks/after-narration.ts"] = generic_hook_module(name, "after-narration")

    elif template == "media-audio":
      permissions.extend(["emit:block", "emit:artifact", "invoke:model", "invoke:job"])
      contributes["hooks"].append({
        "id": f"{name}.after-narration",
        "phase": "afterNarration",
        "trigger": {"type": "event", "event": "narration.completed"},
        "entry": "server/hooks/after-narration.ts",
      })
      contributes["artifactTypes"].append({
        "type": "narration-audio",
        "kind": "audio",
        "mediaType": "audio/mpeg",
      })
      contributes["blockTypes"].append({
        "type": "audio_clip",
        "dataSchema": "schemas/blocks/audio-clip.data.json",
        "responseSchema": "schemas/blocks/audio-clip.response.json",
        "ui": {"component": "schema", "renderer": "audio-clip"},
      })
      settings.append({
        "key": f"{name}.autoPlay",
        "type": "boolean",
        "default": False,
        "scope": "session",
      })
      files["schemas/blocks/audio-clip.data.json"] = object_schema()
      files["schemas/blocks/audio-clip.response.json"] = object_schema()
      files["server/hooks/after-narration.ts"] = generic_hook_module(name, "after-narration")

    manifest = {
      "schemaVersion": "1.0",
      "name": name,
      "version": "0.1.0",
      "description": description,
      "kind": package_kind,
      "defaultEnabled": True,
      "scopes": scopes,
      "permissions": dedupe(permissions),
      "dependencies": [],
      "modelPolicy": {
        "preferredTier": "small"
      },
      "contributes": contributes,
      "settings": settings,
      "state": state,
    }
    files["manifest.json"] = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    return files


def default_kind(template: str) -> str:
    return {
      "command": "core",
      "context-only": "content",
      "interaction-choice": "interaction",
      "mechanic-dice": "mechanic",
      "media-image": "media",
      "media-audio": "media",
    }[template]


def command_module(name: str, description: str) -> str:
    return "\n".join([
      "import { z } from \"zod\";",
      "",
      "export const command = {",
      "  argsSchema: z.object({",
      "    _: z.array(z.string()).default([])",
      "  }),",
      "  async execute() {",
      f"    return {{ content: \"TODO: implement {description}\" }};",
      "  }",
      "};",
      ""
    ])


def context_provider_module(name: str, description: str) -> str:
    return "\n".join([
      "import type {",
      "  PackageContextFragment,",
      "  PackageContextProviderExecutionContext,",
      "  PackageContextProviderInput",
      "} from \"../../../modules/package-runtime/src/index.js\";",
      "",
      "export const contextProvider = {",
      "  async build(",
      "    input: PackageContextProviderInput,",
      "    context: PackageContextProviderExecutionContext",
      "  ): Promise<PackageContextFragment[]> {",
      "    return [",
      "      {",
      f"        id: \"{name}:context\",",
      f"        title: \"{description}\",",
      "        channel: \"reference\",",
      "        priority: 50,",
      "        content: [",
      "          `World: ${context.world?.name ?? input.worldId}`,",
      "          `Session: ${context.session?.id ?? input.sessionId}`",
      "        ].join(\"\\n\")",
      "      }",
      "    ];",
      "  }",
      "};",
      ""
    ])


def choice_command_module(name: str) -> str:
    return "\n".join([
      "import { z } from \"zod\";",
      "",
      "export const command = {",
      "  argsSchema: z.object({",
      "    _: z.array(z.string()).default([])",
      "  }),",
      "  async execute() {",
      "    return {",
      "      content: \"TODO: generate choices\",",
      "      blocks: [",
      "        {",
      "          id: \"blk_local\",",
      "          type: \"choice_set\",",
      "          version: \"1.0\",",
      "          meta: {",
      f"            package: \"{name}\",",
      "            requestId: \"req_local\",",
      "            traceId: \"tr_local\",",
      "            sessionId: \"session_local\",",
      "            turnId: \"turn_local\"",
      "          },",
      "          interaction: {",
      "            requiresResponse: true,",
      "            responseSchema: \"schemas/blocks/choice-set.response.json\",",
      "            submitAs: \"block_response\",",
      "            resumePolicy: \"resume_current_flow\",",
      f"            resumeHandler: \"{name}.resume-choice\"",
      "          },",
      "          data: {",
      "            title: \"TODO: choose\",",
      "            options: [",
      "              { id: \"opt_a\", label: \"TODO option\" }",
      "            ]",
      "          }",
      "        }",
      "      ]",
      "    };",
      "  }",
      "};",
      ""
    ])


def resume_capability_module(name: str) -> str:
    return "\n".join([
      "export const capability = {",
      "  async execute(input) {",
      "    return {",
      "      content: `TODO: handle choice for ${String(input.response.response?.selected ?? \"unknown\")}`",
      "    };",
      "  }",
      "};",
      ""
    ])


def generic_capability_module(name: str, stem: str) -> str:
    return "\n".join([
      "export const capability = {",
      "  async execute(input) {",
      f"    return {{ content: \"TODO: implement {name}.{stem}\", input }};",
      "  }",
      "};",
      ""
    ])


def generic_hook_module(name: str, stem: str) -> str:
    return "\n".join([
      "export const hook = {",
      "  async execute(input) {",
      f"    return {{ content: \"TODO: implement {name}.{stem}\", input }};",
      "  }",
      "};",
      ""
    ])


def skill_markdown(name: str, description: str, template: str) -> str:
    surfaces = {
      "command": "- command\n- optional help/autocomplete",
      "context-only": "- context provider",
      "interaction-choice": "- command\n- block type\n- capability resume handler",
      "mechanic-dice": "- capability\n- block type\n- state collection",
      "media-image": "- hook\n- artifact type\n- block type\n- setting",
      "media-audio": "- hook\n- artifact type\n- block type\n- setting",
    }[template]

    return "\n".join([
      f"# {name}",
      "",
      description,
      "",
      "## Purpose",
      "",
      f"- Template: `{template}`",
      f"- Package goal: {description}",
      "",
      "## Surfaces",
      "",
      surfaces,
      "",
      "## Boundaries",
      "",
      "- Do not call provider SDKs or raw provider HTTP directly.",
      "- Use host-routed model access only when permissions allow it.",
      "- Integrate frontend and backend through host contracts such as commands, blocks, capabilities, and artifacts.",
      ""
    ])


def object_schema() -> str:
    return json.dumps({"type": "object"}, ensure_ascii=False, indent=2) + "\n"


def choice_data_schema() -> str:
    return json.dumps({
      "type": "object",
      "additionalProperties": False,
      "properties": {
        "title": {"type": "string"},
        "options": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {"type": "string"},
              "label": {"type": "string"}
            },
            "required": ["id", "label"]
          }
        }
      },
      "required": ["title", "options"]
    }, ensure_ascii=False, indent=2) + "\n"


def choice_response_schema() -> str:
    return json.dumps({
      "type": "object",
      "additionalProperties": False,
      "properties": {
        "selected": {"type": "string"}
      },
      "required": ["selected"]
    }, ensure_ascii=False, indent=2) + "\n"


def dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
      if value not in seen:
        seen.add(value)
        ordered.append(value)
    return ordered


if __name__ == "__main__":
    raise SystemExit(main())
