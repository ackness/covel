import type { LLMMessage } from "@covel/shared";

export interface LoopStepDigest {
  readonly header: string;
  readonly steps: readonly {
    readonly callId: string;
    readonly text: string;
  }[];
}

// Request-only system messages keep their identity through budgeting, picture
// loading and trace construction. Provenance never enters model or trace JSON.
const digests = new WeakMap<object, LoopStepDigest>();

export function loopStepDigestMessage(digest: LoopStepDigest): LLMMessage {
  const message: LLMMessage = {
    role: "system",
    content: [digest.header, ...digest.steps.map((step) => step.text)].join(
      "\n",
    ),
  };
  digests.set(message, digest);
  return message;
}

export function loopStepDigestOf(message: object): LoopStepDigest | undefined {
  return digests.get(message);
}
