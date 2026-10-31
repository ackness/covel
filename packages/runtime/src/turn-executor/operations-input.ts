import { operationsInputSchema, type RuntimeResult } from "@covel/shared";
import { commitEligibility } from "../session/session-runtime-result.js";
import { inCommitOrder } from "./nested-results.js";
import { freezeSnapshot } from "./turn-digest.js";

/**
 * Take an owned snapshot at binding time; later siblings cannot change it.
 * `producerIds` track only this execution's staged operations: the reader
 * depends on them at commit (`read-dependencies.ts`). Committed seed
 * operations are read-only recovery context, never new writes or dependencies.
 * All ids stay out of the value itself.
 */
export function buildOperationsInput(
  results: ReadonlyMap<string, RuntimeResult>,
  seeds?: ReadonlySet<RuntimeResult>,
) {
  const committed = inCommitOrder(
    [...results.values()].filter((result) => seeds?.has(result)),
  )
    .flatMap((result) => result.operations ?? [])
    .filter((operation) => operation.status === "committed")
    .sort((a, b) => a.seq - b.seq);
  const completed = [...results.values()].filter(
    (result) => !seeds?.has(result) && commitEligibility(result) !== "none",
  );
  const staged = inCommitOrder(completed)
    .filter((result) => commitEligibility(result) !== "none")
    .flatMap((result) => result.operations ?? [])
    .filter((operation) => operation.status === "staged")
    .sort((a, b) => a.seq - b.seq);
  const operations = [...committed, ...staged].map(
    ({ contract, summary, request, result, truncated }) => ({
      contract,
      summary,
      ...(request !== undefined ? { request } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(truncated ? { truncated } : {}),
    }),
  );
  return {
    value: freezeSnapshot(
      operationsInputSchema.parse(structuredClone({ operations })),
    ),
    producerIds: staged.map((operation) => operation.id),
  };
}
