import { AsyncLocalStorage } from "node:async_hooks";
import type { LLMRequestBudget } from "@covel/shared";

/** Host-owned context, never an author-supplied gateway input. */
export const functionRequestBudget = new AsyncLocalStorage<LLMRequestBudget>();
