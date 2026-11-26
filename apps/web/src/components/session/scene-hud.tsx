import { useTranslation } from "react-i18next";
import type { CharacterVisualModel, StageCastModel } from "@covel/shared";
import { Media } from "@/components/Media.js";
import { isMediaRef } from "@/lib/media-ref-utils.js";
import { useUiSlot, useUiSlots } from "@/stores/ui-slot-store.js";
import { useSession } from "@/stores/session-store.js";
import { lastStorySpeaker } from "./stage/stage-dialogue-selectors.js";
import {
  PlayerItems,
  PlayerStatusMeters,
  usePlayerStatus,
} from "./player-status.js";
import {
  readoutLines,
  SummaryLines,
  useSessionSummary,
} from "./session-summary.js";

type CastActor = StageCastModel["actors"][number];

/** The scene has room for a few faces; the character panel lists everyone. */
const MAX_CAST = 3;

/**
 * Who is in the scene and how the player is doing, laid over the scene art in
 * the `backdrop: "scene"` layout. Everything comes from kernel data — the
 * stage cast, character visual and session summary slots, and the player's
 * World Model record — so it shows for any world that provides them and stays
 * empty otherwise.
 */
export function SceneHud({
  sessionId,
  storyWidth,
  hostWidth,
}: {
  readonly sessionId: string;
  readonly storyWidth: number;
  readonly hostWidth: number;
}) {
  const { t } = useTranslation();
  const { state } = useSession();
  const status = usePlayerStatus();
  const summary = useSessionSummary(sessionId);
  const hasStatus = status !== null || summary.length > 0;
  const roomy = hostWidth >= Math.max(1056, storyWidth + 448);
  const slots = useUiSlots(sessionId);
  const cast = slots.find((entry) => entry.slot === "stage.cast@1")?.value as
    StageCastModel | undefined;
  const actors = (cast?.actors ?? [])
    .filter((actor) => !actor.exiting)
    .slice(0, MAX_CAST);

  // The last attributed segment of the latest story names who is speaking;
  const latestStory = state.messages.findLast(
    (message) => message.kind === "story",
  );
  const lastSpeaker = lastStorySpeaker(latestStory);
  const speakingId = actors.find((actor) =>
    lastSpeaker?.characterId
      ? actor.characterId === lastSpeaker.characterId
      : actor.displayName === lastSpeaker?.name,
  )?.characterId;
  // Otherwise the stage view's highlight rule: explicit flags win; with none
  // set, the first actor on stage is the one in focus.
  const flagged = actors.some((actor) => actor.active !== undefined);

  return (
    <div
      data-shown={roomy && (hasStatus || actors.length > 0)}
      className="ui-scene-hud pointer-events-none absolute bottom-6 left-6 z-1 flex-col gap-3"
    >
      {actors.length > 0 && (
        <ul
          aria-label={t("session.sceneCast")}
          className="flex items-end gap-3"
        >
          {actors.map((actor, index) => (
            <CastCard
              key={actor.characterId}
              actor={actor}
              sessionId={sessionId}
              speaking={actor.characterId === speakingId}
              focused={
                speakingId
                  ? actor.characterId === speakingId
                  : flagged
                    ? actor.active === true
                    : index === 0
              }
            />
          ))}
        </ul>
      )}
      {hasStatus && (
        <div
          role="group"
          aria-label={t("session.playerStatus")}
          className="ui-scene-card ui-scene-status pointer-events-auto flex w-76 flex-col gap-2.5 px-4 py-3.5"
        >
          {status?.name && (
            <span className="ui-title text-base leading-tight">
              {status.name}
            </span>
          )}
          {status && <PlayerStatusMeters status={status} layout="rows" />}
          {status && <PlayerItems items={status.items} max={4} />}
          <SummaryLines lines={[...readoutLines(status), ...summary]} />
        </div>
      )}
    </div>
  );
}

function CastCard({
  actor,
  sessionId,
  focused,
  speaking,
}: {
  readonly actor: CastActor;
  readonly sessionId: string;
  readonly focused: boolean;
  readonly speaking: boolean;
}) {
  const { t } = useTranslation();
  const speakingTag = speaking && (
    <span className="ui-scene-speaking">{t("session.sceneSpeaking")}</span>
  );
  const visual = useUiSlot(sessionId, "character.visual@1", actor.characterId)
    ?.value as CharacterVisualModel | undefined;
  const portrait = [visual?.avatar, visual?.sprite].find(isMediaRef);

  // No art for this character: a name plate, not an empty frame.
  if (!portrait) {
    return (
      <li
        data-focused={focused}
        className="ui-scene-card ui-scene-cast pointer-events-auto flex items-center gap-2 px-3.5 py-2"
      >
        <span className="ui-title text-base leading-tight">
          {actor.displayName}
        </span>
        {speakingTag}
      </li>
    );
  }

  return (
    <li
      data-focused={focused}
      className={`ui-scene-card ui-scene-cast pointer-events-auto relative overflow-hidden ${
        focused ? "h-60 w-42" : "h-44 w-31"
      }`}
    >
      <Media
        src={portrait}
        sessionId={sessionId}
        alt=""
        fit="cover"
        rounded="none"
        aspectRatio="auto"
        className="h-full w-full object-top"
      />
      <span
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-black/90 via-black/45 to-transparent"
      />
      <span className="absolute inset-x-3 bottom-2.5 flex flex-col items-start gap-1">
        {speakingTag}
        <span className="ui-title text-lg leading-tight text-white">
          {actor.displayName}
        </span>
      </span>
    </li>
  );
}
