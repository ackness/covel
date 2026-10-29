/**
 * Action types shared by the server, the runtime and the web client. The
 * resolved `TurnAction` lives in the author SDK so plugins read the same
 * shape; the Zod schemas and the role table are in `schemas/action.ts`.
 */

import type {
  SeatController,
  SeatRole,
  TurnAction,
} from "@covel/plugin-handlers-utils";
import type { I18nText } from "./world.js";

export type {
  TurnAction,
  TurnActionInteraction,
} from "@covel/plugin-handlers-utils";

/** The kernel's own kinds. */
export type BaseActionKind =
  "say" | "act" | "narrate" | "direct" | "advance" | "command";

/** Whether an action of a kind carries text. */
export type ActionTextRule = "required" | "optional" | "none";

/**
 * One action as a client submits it: `source` is never sent, `seatId` and
 * `actorId` may be left to the server's defaults.
 */
export type TurnActionRequest = Omit<TurnAction, "seatId" | "source"> & {
  readonly seatId?: string;
};

/** The rules the server checks an action of one kind against. */
export interface ActionKindRule {
  /** Wire kind: a base kind or `<pluginId>/<name>`. */
  readonly kind: string;
  readonly roles: readonly SeatRole[];
  readonly text: ActionTextRule;
  /** Whether the action is taken as a character. */
  readonly actor: boolean;
}

/** One entry of a session's action-kind catalogue. */
export interface ActionKindDescriptor extends ActionKindRule {
  /** `framework` for a base kind, `plugin` for a declared one. */
  readonly source: "framework" | "plugin";
  /** The declaring plugin; absent for a base kind. */
  readonly pluginId?: string;
  readonly display: {
    readonly label: I18nText;
    readonly icon?: string;
    readonly placeholder?: I18nText;
  };
  /** JSON Schema the action's `fields` must match; absent when it takes none. */
  readonly fieldsSchema?: Readonly<Record<string, unknown>>;
}

/** `GET /api/sessions/:id/action-kinds`. */
export interface SessionActionKindsResponse {
  readonly kinds: readonly ActionKindDescriptor[];
  /** Each seat of the session and the kinds it may submit now. */
  readonly seats: readonly {
    readonly seatId: string;
    readonly role: SeatRole;
    readonly controller: SeatController;
    /** Empty for a seat without a human controller. */
    readonly allowed: readonly string[];
  }[];
}
