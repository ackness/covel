import { useMemo } from "react";
import type { ComponentRenderer } from "@json-render/react";
import type { MediaRef } from "@covel/shared";
import { Media } from "@/components/Media.js";
import { isMediaRef } from "@/lib/media-ref-utils.js";
import { usePluginNamespace } from "@/stores/plugin-data-store.js";
import { useActiveSessionId } from "./session-context.js";

/**
 * Resolve a character's avatar MediaRef from a presence-style namespace.
 *
 * The character list keys rows by `<sessionId>-<characterId>`, while presence
 * records key by the bare `characterId` (e.g. `npc-lin-yuanzhou`). Match by
 * exact id or by the `-<characterId>` suffix so the avatar lines up regardless
 * of the session prefix. Returns null when there's no match or the matched
 * record carries no avatar ref — i.e. the no-portrait case renders nothing.
 */
export function resolveCharacterAvatar(
  records: Record<string, unknown>,
  characterId: string | undefined,
  idField: string,
  refField: string,
): MediaRef | null {
  if (!characterId) return null;
  for (const value of Object.values(records)) {
    if (!value || typeof value !== "object") continue;
    const rec = value as Record<string, unknown>;
    const pid = typeof rec[idField] === "string" ? rec[idField] : undefined;
    if (!pid) continue;
    if (characterId === pid || characterId.endsWith(`-${pid}`)) {
      return isMediaRef(rec[refField]) ? rec[refField] : null;
    }
  }
  return null;
}

/**
 * CharacterAvatar — a small portrait badge for a character row.
 *
 * Generic by design (no hard-coded plugin id): the owning panel's spec passes
 * which plugin/namespace holds the presence records — char-creator wires it to
 * `character-presence` / `presence`. Renders nothing when the character has no
 * portrait, so character lists in worlds without presence data are unchanged.
 */
export const CharacterAvatar: ComponentRenderer = ({ element }) => {
  const props = element.props ?? {};
  const characterId =
    typeof props.characterId === "string" ? props.characterId : undefined;
  const sourcePlugin =
    typeof props.sourcePlugin === "string" ? props.sourcePlugin : "";
  const sourceNamespace =
    typeof props.sourceNamespace === "string"
      ? props.sourceNamespace
      : "presence";
  const idField =
    typeof props.idField === "string" ? props.idField : "characterId";
  const refField =
    typeof props.refField === "string" ? props.refField : "avatar";
  const size = typeof props.size === "number" ? props.size : 28;

  const sessionId = useActiveSessionId();
  const records = usePluginNamespace(sourcePlugin, sourceNamespace);
  const avatar = useMemo(
    () => resolveCharacterAvatar(records, characterId, idField, refField),
    [records, characterId, idField, refField],
  );

  if (!avatar) return null;
  return (
    <span
      className="inline-block shrink-0 overflow-hidden rounded-md border border-border"
      style={{ width: size, height: size }}
    >
      <Media
        src={avatar}
        sessionId={sessionId}
        alt=""
        aspectRatio="1/1"
        rounded="md"
        fit="cover"
      />
    </span>
  );
};
