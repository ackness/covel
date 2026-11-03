import { Reveal } from "@/lib/reveal/Reveal.js";
import { useStoryReveal } from "@/lib/reveal/story-reveal-context.js";
/**
 * The body of a committed story in the chat view, drawn through the plugin
 * segment templates (`contributes.ui.segment`) that match its segments.
 *
 * A story with no matching template and no named speaker renders as plain
 * narrative (`NarrativeMessageBody` of its content). Otherwise each segment
 * renders in order: a matched one through its template, inside a boundary
 * that falls back to that segment's default, and an unmatched one as the
 * default: its text, headed by the speaker's name for a non-narration
 * segment that names one. Templates are display-only json-render views with
 * no actions, drawn with the display components alone
 * (`segmentTemplateRegistry`).
 */
import {
  Component,
  memo,
  useContext,
  useMemo,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { JSONUIProvider, Renderer } from "@json-render/react";
import type { CharacterVisualModel, SnapshotCharacter } from "@covel/shared";
import { Markdown } from "@/components/ui/markdown.js";
import { SegmentTemplateContext } from "@/lib/catalog/segment-template-context.js";
import { segmentTemplateRegistry } from "@/lib/catalog.js";
import { covelDirectives } from "@/lib/json-render-directives.js";
import { pluginPanelViewToSpec } from "@/lib/plugin-panel-spec.js";
import {
  compileSegmentTemplates,
  planSegmentTemplates,
  segmentTemplateState,
  segmentRevealPolicy,
  type SegmentTemplate,
  type SegmentTemplateState,
} from "@/lib/segment-templates.js";
import { SessionStateContext } from "@/stores/session-store/context.js";
import type { StreamMessage } from "@/stores/session-store.js";
import { useUiSlots } from "@/stores/ui-slot-store.js";
import { NarrativeMessageBody } from "./message-primitives.js";

const NO_CHARACTERS: readonly SnapshotCharacter[] = [];
const NO_ACTIONS = {};

/** A committed story's body: templated segments, or today's rendering. */
export function StoryMessageBody({
  message,
  sessionId,
}: {
  readonly message: Pick<StreamMessage, "id" | "content" | "segments">;
  readonly sessionId: string | undefined;
}) {
  // The chat shows drafts, so a story read there as a draft is not replayed.
  const admission = useStoryReveal(message, { showsDrafts: true });
  const state = useContext(SessionStateContext);
  const entries = state?.segmentUiSpecs;
  const templates = useMemo(
    () => (entries?.length ? compileSegmentTemplates(entries) : []),
    [entries],
  );
  const segments = message.segments;
  const plan = useMemo(() => {
    if (!segments) return undefined;
    // Without a matching template, named speakers still get the default
    // nameplate instead of disappearing into plain prose.
    return (
      planSegmentTemplates(templates, segments) ??
      (segments.some(speakerOf) ? segments.map(() => undefined) : undefined)
    );
  }, [templates, segments]);
  if (!segments || !plan)
    return (
      <NarrativeMessageBody
        themeSessionId={sessionId}
        isUser={false}
        isHiddenAssistantKind={false}
        content={message.content}
      />
    );
  const characters = state?.gameState.characters;
  return (
    <TemplatedStory
      admission={admission}
      messageId={message.id}
      segments={segments}
      plan={plan}
      characters={Array.isArray(characters) ? characters : NO_CHARACTERS}
      sessionId={sessionId ?? ""}
    />
  );
}

const TemplatedStory = memo(function TemplatedStory({
  admission,
  messageId,
  segments,
  plan,
  characters,
  sessionId,
}: {
  readonly admission: ReturnType<typeof useStoryReveal>;
  readonly messageId: string;
  readonly segments: NonNullable<StreamMessage["segments"]>;
  readonly plan: readonly (SegmentTemplate | undefined)[];
  readonly characters: readonly SnapshotCharacter[];
  readonly sessionId: string;
}) {
  const visualSlots = useUiSlots(sessionId, "character.visual@1");
  const visuals = useMemo(
    () =>
      new Map(
        visualSlots
          .filter((entry) => entry.key && entry.value)
          .map((entry) => [entry.key!, entry.value as CharacterVisualModel]),
      ),
    [visualSlots],
  );
  return (
    <div
      data-testid="story-segments"
      className="ui-message-assistant ui-narrative prose prose-sm max-w-none border-0 p-0 text-sm wrap-break-word w-full"
    >
      <Reveal
        revealKey={messageId}
        {...admission}
        {...segmentRevealPolicy(plan)}
      >
        {segments.map((segment, index) => {
          const template = plan[index];
          const fallback = (
            <DefaultSegment segment={segment} sessionId={sessionId} />
          );
          if (!template) return <div key={index}>{fallback}</div>;
          return (
            <div key={index} data-segment-template={template.pluginId}>
              <SegmentTemplateBoundary fallback={fallback}>
                <div className="not-prose">
                  <SegmentTemplateView
                    sessionId={sessionId}
                    view={template.spec.view}
                    state={segmentTemplateState(
                      segment,
                      index,
                      characters,
                      visuals,
                    )}
                  />
                </div>
              </SegmentTemplateBoundary>
            </div>
          );
        })}
      </Reveal>
    </div>
  );
});

type Segment = NonNullable<StreamMessage["segments"]>[number];

/** The speaker a segment's default rendering names, if any. */
function speakerOf(segment: Segment): string | undefined {
  const speaker = segment.speaker?.trim();
  return segment.kind !== "narration" && speaker ? speaker : undefined;
}

/** A segment without a template: its text, headed by its speaker's name. */
function DefaultSegment({
  segment,
  sessionId,
}: {
  readonly segment: Segment;
  readonly sessionId: string;
}) {
  const speaker = speakerOf(segment);
  return (
    <>
      {speaker && (
        <span
          data-testid="segment-speaker"
          className="not-prose mb-0.5 block text-xs font-semibold text-(--accent-primary)"
        >
          {speaker}
        </span>
      )}
      <Markdown themeSessionId={sessionId}>{segment.text}</Markdown>
    </>
  );
}

function SegmentTemplateView({
  sessionId,
  view,
  state,
}: {
  readonly sessionId: string;
  readonly view: Record<string, unknown> | undefined;
  readonly state: SegmentTemplateState;
}) {
  const spec = useMemo(() => pluginPanelViewToSpec(view), [view]);
  if (!spec) throw new Error("segment template has no view");
  return (
    // Keyed by its state: the provider reads state once, on mount.
    <SegmentTemplateContext.Provider
      value={{ sessionId, character: state.character, visual: state.visual }}
    >
      <JSONUIProvider
        key={JSON.stringify([sessionId, state])}
        registry={segmentTemplateRegistry}
        initialState={state}
        handlers={NO_ACTIONS}
        directives={covelDirectives}
      >
        <Renderer spec={spec} registry={segmentTemplateRegistry} />
      </JSONUIProvider>
    </SegmentTemplateContext.Provider>
  );
}

/** A template that fails draws its segment's default text instead. */
class SegmentTemplateBoundary extends Component<
  { readonly fallback: ReactNode; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn(
      "[segment-template] render failed; showing the default text",
      error,
      info.componentStack,
    );
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
