/** Commit handler for `narrative.append` — persists narrative messages. */

import {
  resolveCharacter,
  type CommitResult,
  type ProposalFor,
  type StoryCues,
  type StoryMessageSegment,
  type StorySegment,
} from "@covel/shared";
import { makeEvent } from "../session/session-kernel-helpers.js";
import type { KernelStore } from "../session/session-kernel-store.js";
import type { CommitHandlerMap } from "./commit-handler-types.js";

type StoryCharacter = {
  readonly id: string;
  readonly name: string;
  readonly aliases?: readonly string[];
};

interface StoryRecord {
  readonly segments: readonly StoryMessageSegment[];
  readonly presentCharacterIds: readonly string[];
  readonly cues?: StoryCues;
  readonly yield?: string;
  readonly unresolvedSpeakers: readonly string[];
}

/** An append without segments reads as narration, one segment per paragraph. */
function segmentsFromContent(content: string): StorySegment[] {
  return content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((text) => ({ kind: "narration" as const, text }));
}

/**
 * Resolve a story's speakers and `cues.present` names to characters (exact
 * ID, name or alias; never a partial match) and record who was present. A
 * name that matches no character, or more than one, stays as written: a new
 * character can speak before any plugin records it, and an ambiguous name
 * cannot be settled without showing IDs to the model.
 */
function resolveStory(
  payload: ProposalFor<"narrative.append">["payload"],
  characters: readonly StoryCharacter[],
): StoryRecord {
  const unresolved = new Set<string>();
  const present = new Set<string>();
  const lookup = (name: string): StoryCharacter | undefined => {
    const resolution = resolveCharacter(characters, name);
    if (resolution.status === "found") return resolution.character;
    unresolved.add(name);
    return undefined;
  };
  const segments = (
    payload.segments ?? segmentsFromContent(payload.content)
  ).map((segment): StoryMessageSegment => {
    if (!segment.speaker) return { kind: segment.kind, text: segment.text };
    const character = lookup(segment.speaker);
    if (!character)
      return {
        kind: segment.kind,
        speaker: segment.speaker,
        text: segment.text,
      };
    present.add(character.id);
    return {
      kind: segment.kind,
      speaker: character.name,
      speakerId: character.id,
      text: segment.text,
    };
  });
  for (const name of payload.cues?.present ?? []) {
    const character = lookup(name);
    if (character) present.add(character.id);
  }
  return {
    segments,
    presentCharacterIds: [...present],
    ...(payload.cues ? { cues: payload.cues } : {}),
    ...(payload.yield ? { yield: payload.yield } : {}),
    unresolvedSpeakers: [...unresolved],
  };
}

export function createNarrativeCommitHandlers(
  store: KernelStore,
): Pick<CommitHandlerMap, "narrative.append"> {
  async function commitNarrative(
    proposal: ProposalFor<"narrative.append">,
  ): Promise<CommitResult> {
    const { content, kind } = proposal.payload;
    // Read through the commit's store view, so a character this batch
    // created before the story already resolves.
    const story =
      kind === "story"
        ? resolveStory(
            proposal.payload,
            (await store.listCharacters?.(proposal.sessionId)) ?? [],
          )
        : undefined;
    await store.addMessage({
      id: proposal.id,
      sessionId: proposal.sessionId,
      role: kind === "system" ? "system" : "assistant",
      content,
      metadata: {
        turnId: proposal.turnId,
        runtimeId: proposal.source.runtimeId,
        kind,
        ...(story
          ? {
              segments: story.segments,
              presentCharacterIds: story.presentCharacterIds,
              ...(story.cues ? { cues: story.cues } : {}),
              ...(story.yield ? { yield: story.yield } : {}),
            }
          : {}),
      },
      createdAt: proposal.timestamp,
    });
    return {
      committed: true,
      event: makeEvent("narrative.completed", proposal, {
        content,
        kind,
        messageId: proposal.id,
        ...(story && story.unresolvedSpeakers.length > 0
          ? { unresolvedSpeakers: story.unresolvedSpeakers }
          : {}),
      }),
    };
  }

  return { "narrative.append": commitNarrative };
}
