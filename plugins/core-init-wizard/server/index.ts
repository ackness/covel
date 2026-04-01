import type { PluginRegistrar } from "@covel/plugin-runtime";
import type { RuntimeHandlerContext, RuntimeHandlerResult } from "@covel/plugin-runtime";
import type { CharacterCreateInput } from "@covel/shared";

export default function register(registrar: PluginRegistrar) {
  registrar.addRuntimeHandler("init-wizard", initWizardHandler);
}

/**
 * On session_start, emit a character_creation UI block
 * prompting the player to create their character.
 *
 * The submitted form data maps to CharacterCreateInput:
 *   character_name  -> name
 *   character_desc  -> description
 *   character_type  -> type (default: "player")
 */
async function initWizardHandler(
  ctx: RuntimeHandlerContext
): Promise<RuntimeHandlerResult> {
  const isZh = ctx.locale.startsWith("zh");

  return {
    proposals: [
      {
        kind: "ui.render",
        payload: {
          type: "character_creation",
          content: {
            title: isZh ? "创建你的角色" : "Create Your Character",
            description: isZh
              ? "为你的角色取一个名字，开始这段冒险。"
              : "Give your character a name to begin the adventure.",
            fields: [
              {
                id: "character_name",
                type: "text",
                label: isZh ? "角色名" : "Character Name",
                placeholder: isZh ? "请输入角色名..." : "Enter character name...",
                required: true,
              },
              {
                id: "character_desc",
                type: "textarea",
                label: isZh ? "角色描述" : "Character Description",
                placeholder: isZh ? "简单描述你的角色（可选）..." : "Briefly describe your character (optional)...",
                required: false,
              },
            ],
            submitLabel: isZh ? "开始冒险" : "Begin Adventure",
            submitMapping: {
              character_name: "name",
              character_desc: "description",
            } satisfies Record<string, keyof CharacterCreateInput>,
          },
        },
      },
    ],
  };
}
