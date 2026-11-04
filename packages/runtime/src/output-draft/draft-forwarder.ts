/**
 * Turns a story runtime's `submit-output` arguments into output drafts while
 * the model writes them, and says when a draft is void or final.
 *
 * One forwarder serves one runtime run. Each model request and provider
 * attempt is its own draft (`runId:request:attempt`); everything a void
 * attempt showed is retracted before the next one shows anything. Drafts are
 * a view: they never change what the runtime returns or commits.
 */
import type {
  OutputAcceptedPayload,
  OutputDraftPayload,
  OutputRetractedPayload,
} from "@covel/shared";
import {
  liveOutputPlan,
  type LiveOutputPlan,
} from "@covel/shared/plugin-runtime";
import type { RuntimeManifest } from "@covel/shared";
import type {
  ArgumentStreamObserver,
  ToolArgumentFragment,
} from "../retry/llm-retry.js";
import { DisplayStreamParser, displayUnitsOf } from "./display-parser.js";

export type OutputDraftEvent =
  | { readonly type: "output.draft"; readonly payload: OutputDraftPayload }
  | {
      readonly type: "output.retracted";
      readonly payload: OutputRetractedPayload;
    }
  | {
      readonly type: "output.accepted";
      readonly payload: OutputAcceptedPayload;
    };

/** Where drafts go: the live action stream only, never traces or storage. */
export type OutputDraftSink = (event: OutputDraftEvent) => void;

export interface DraftForwarder {
  /** Watches one model request's tool-call arguments. */
  observe(): ArgumentStreamObserver;
  /** The latest request was not accepted; whatever it showed is void. */
  revise(): void;
  /** The run ends without a story; whatever it showed is void. */
  stop(): void;
  /** The submission passed every check; these are its final units. */
  accept(output: Readonly<Record<string, unknown>>): void;
}

/** Text mode sends the unit being written at most this often. */
const TEXT_INTERVAL_MS = 80;

export function createDraftForwarder(options: {
  readonly sink: OutputDraftSink | undefined;
  readonly manifest: RuntimeManifest;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly turnId: string;
  readonly runId: string;
  readonly toolName: string;
  /**
   * A hook holds drafts: nothing shows while the model writes. With
   * `"review"` the story appears once, when its submission is accepted; with
   * `"commit"` it appears only with the committed story.
   */
  readonly hold?: "review" | "commit";
}): DraftForwarder | undefined {
  const { sink, manifest } = options;
  if (!sink) return undefined;
  const plan = liveOutputPlan(manifest, options.schema);
  if (!plan) return undefined;
  return new Forwarder(sink, plan, options.hold, {
    turnId: options.turnId,
    runtimeId: manifest.name,
    pluginId: manifest.pluginId,
    runId: options.runId,
    toolName: options.toolName,
  });
}

interface Call {
  name: string | undefined;
  readonly parser: DisplayStreamParser;
}

class Forwarder implements DraftForwarder {
  private request = 0;
  private draftId: string | undefined;
  /** The draft the client holds, if any: shown, accepted, or neither. */
  private shown: string | undefined;
  /** A draft the client still shows as being revised, until the next one. */
  private revising: string | undefined;
  private calls = new Map<number, Call>();
  private submission: number | undefined;
  private lastSent = "";
  private lastUnitsKey = "";
  private lastSentAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly sink: OutputDraftSink,
    private readonly plan: LiveOutputPlan,
    private readonly hold: "review" | "commit" | undefined,
    private readonly identity: {
      readonly turnId: string;
      readonly runtimeId: string;
      readonly pluginId: string;
      readonly runId: string;
      readonly toolName: string;
    },
  ) {}

  observe(): ArgumentStreamObserver {
    const request = ++this.request;
    if (this.hold) return { fragment: () => {}, reset: () => {} };
    let attempt: number | undefined;
    return {
      fragment: (at, fragment) => {
        if (attempt !== at) {
          attempt = at;
          this.begin(`${this.identity.runId}:${request}:${at}`);
        }
        this.fragment(fragment);
      },
      reset: () => {
        attempt = undefined;
        this.retract("revising");
      },
    };
  }

  revise(): void {
    this.retract("revising");
  }

  stop(): void {
    this.retract("stopped");
  }

  accept(output: Readonly<Record<string, unknown>>): void {
    this.cancelTimer();
    // A later hook may still replace the story; the commit shows it.
    if (this.hold === "commit") return;
    const draftId =
      this.draftId ?? `${this.identity.runId}:${this.request}:accepted`;
    this.draftId = draftId;
    this.shown = draftId;
    this.revising = undefined;
    this.emit({
      type: "output.accepted",
      payload: {
        ...this.base(draftId),
        units: displayUnitsOf(output, this.plan.display),
      },
    });
  }

  private base(draftId: string) {
    return {
      turnId: this.identity.turnId,
      runtimeId: this.identity.runtimeId,
      pluginId: this.identity.pluginId,
      draftId,
    };
  }

  private begin(draftId: string): void {
    this.retract("revising");
    this.draftId = draftId;
    this.calls = new Map();
    this.submission = undefined;
    this.lastSent = "";
    this.lastUnitsKey = "";
  }

  private retract(reason: OutputRetractedPayload["reason"]): void {
    this.cancelTimer();
    // A stop also clears a draft that is still marked as being revised.
    const shown =
      this.shown ?? (reason === "stopped" ? this.revising : undefined);
    this.revising =
      reason === "revising" ? (shown ?? this.revising) : undefined;
    this.shown = undefined;
    this.draftId = undefined;
    this.calls = new Map();
    this.submission = undefined;
    this.lastSent = "";
    this.lastUnitsKey = "";
    if (shown)
      this.emit({
        type: "output.retracted",
        payload: { ...this.base(shown), reason },
      });
  }

  private fragment(fragment: ToolArgumentFragment): void {
    // Without an index the provider streams no argument text at all.
    if (fragment.index === undefined) return;
    let call = this.calls.get(fragment.index);
    if (!call) {
      call = {
        name: undefined,
        parser: new DisplayStreamParser(this.plan.display),
      };
      this.calls.set(fragment.index, call);
    }
    call.name ??= fragment.name;
    if (fragment.arguments !== undefined)
      call.parser.replace(fragment.arguments);
    else if (fragment.argumentsDelta) call.parser.push(fragment.argumentsDelta);
    if (call.name !== this.identity.toolName) return;
    this.submission ??= fragment.index;
    if (this.submission !== fragment.index) return;
    this.publish(call.parser);
  }

  private publish(parser: DisplayStreamParser): void {
    const units = parser.completeUnits();
    const partial =
      this.plan.mode === "text" ? parser.partialUnit() : undefined;
    // Finished units only grow, so their revision stands in for them.
    const unitsKey = parser.completeRevision;
    const key = JSON.stringify([unitsKey, partial]);
    if (key === this.lastSent) return;
    // Nothing to show yet, and nothing shown that would need clearing.
    if (units.length === 0 && !partial && this.shown !== this.draftId) return;
    // The parser keeps adding to its list; send the units this key names.
    const sent = [...units];
    const send = () => {
      this.timer = undefined;
      const draftId = this.draftId;
      if (!draftId) return;
      this.lastSent = key;
      this.lastUnitsKey = unitsKey;
      this.lastSentAt = Date.now();
      this.shown = draftId;
      this.revising = undefined;
      this.emit({
        type: "output.draft",
        payload: {
          ...this.base(draftId),
          mode: this.plan.mode,
          units: sent,
          ...(partial ? { partial } : {}),
        },
      });
    };
    // A change to the complete units goes out at once; a growing one is paced.
    const grew = unitsKey !== this.lastUnitsKey;
    this.cancelTimer();
    const wait = TEXT_INTERVAL_MS - (Date.now() - this.lastSentAt);
    if (grew || wait <= 0) send();
    else this.timer = setTimeout(send, wait);
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private emit(event: OutputDraftEvent): void {
    try {
      this.sink(event);
    } catch {
      // A broken stream must not fail the runtime; the commit still lands.
    }
  }
}
