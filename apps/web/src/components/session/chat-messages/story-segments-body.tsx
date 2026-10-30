/**
 * The body of a committed story in the chat view, drawn through the plugin
 * segment templates (`contributes.ui.segment`) that match its segments.
 *
 * A story with no matching template renders exactly as before
 * (`NarrativeMessageBody` of its content). Otherwise each segment renders in
 * order: a matched one through its template, inside a boundary that falls
 * back to that segment's default text, and an unmatched one as default
 * prose. Templates are display-only json-render views with no actions.
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
import { covelRegistry } from "@/lib/catalog.js";
import { covelDirectives } from "@/lib/json-render-directives.js";
import { pluginPanelViewToSpec } from "@/lib/plugin-panel-spec.js";
import {
  compileSegmentTemplates,
  planSegmentTemplates,
  segmentTemplateState,
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
  readonly message: Pick<StreamMessage, "content" | "segments">;
  readonly sessionId: string | undefined;
}) {
  const state = useContext(SessionStateContext);
  const entries = state?.segmentUiSpecs;
  const templates = useMemo(
    () => (entries?.length ? compileSegmentTemplates(entries) : []),
    [entries],
  );
  const segments = message.segments;
  const plan = useMemo(
    () => (segments ? planSegmentTemplates(templates, segments) : undefined),
    [templates, segments],
  );
  if (!segments || !plan)
    return (
      <NarrativeMessageBody
        isUser={false}
        isHiddenAssistantKind={false}
        content={message.content}
      />
    );
  const characters = state?.gameState.characters;
  return (
    <TemplatedStory
      segments={segments}
      plan={plan}
      characters={Array.isArray(characters) ? characters : NO_CHARACTERS}
      sessionId={sessionId ?? ""}
    />
  );
}

const TemplatedStory = memo(function TemplatedStory({
  segments,
  plan,
  characters,
  sessionId,
}: {
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
      {segments.map((segment, index) => {
        const template = plan[index];
        const fallback = <Markdown>{segment.text}</Markdown>;
        if (!template) return <div key={index}>{fallback}</div>;
        return (
          <div key={index} data-segment-template={template.pluginId}>
            <SegmentTemplateBoundary fallback={fallback}>
              <div className="not-prose">
                <SegmentTemplateView
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
    </div>
  );
});

function SegmentTemplateView({
  view,
  state,
}: {
  readonly view: Record<string, unknown> | undefined;
  readonly state: SegmentTemplateState;
}) {
  const spec = useMemo(() => pluginPanelViewToSpec(view), [view]);
  if (!spec) throw new Error("segment template has no view");
  return (
    // Keyed by its state: the provider reads state once, on mount.
    <JSONUIProvider
      key={JSON.stringify(state)}
      registry={covelRegistry}
      initialState={state}
      handlers={NO_ACTIONS}
      directives={covelDirectives}
    >
      <Renderer spec={spec} registry={covelRegistry} />
    </JSONUIProvider>
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
