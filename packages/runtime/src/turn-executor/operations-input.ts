import { operationsInputSchema, type RuntimeResult } from "@covel/shared";
import { commitEligibility } from "../session/session-runtime-result.js";
import { inCommitOrder } from "./nested-results.js";
import { freezeSnapshot } from "./turn-digest.js";

/** Take an owned snapshot at binding time; later siblings cannot change it. */
export function buildOperationsInput(
  results: ReadonlyMap<string, RuntimeResult>,
  seeds?: ReadonlySet<RuntimeResult>,
) {
  const completed = [...results.values()].filter(
    (result) => !seeds?.has(result) && commitEligibility(result) !== "none",
  );
  const operations = inCommitOrder(completed)
    .filter((result) => commitEligibility(result) !== "none")
    .flatMap((result) => result.operations ?? [])
    .filter((operation) => operation.status === "staged")
    .sort((a, b) => a.seq - b.seq)
    .map(({ contract, summary, request, result, truncated }) => ({
      contract,
      summary,
      ...(request !== undefined ? { request } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(truncated ? { truncated } : {}),
    }));
  return freezeSnapshot(
    operationsInputSchema.parse(structuredClone({ operations })),
  );
}
