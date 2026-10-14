import { singleFlight } from "../middleware/rate-limit.js";

/** All world authoring routes share one admission mark, held through SSE cleanup. */
export const worldAuthoringFlight = singleFlight(() => "world-authoring");
