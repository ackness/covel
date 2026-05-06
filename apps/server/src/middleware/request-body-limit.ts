import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

export const DEFAULT_BODY_LIMIT_BYTES = 1 * 1024 * 1024;
export const INSTALL_BODY_LIMIT_BYTES = 20 * 1024 * 1024;

const defaultBodyLimit = bodyLimit({ maxSize: DEFAULT_BODY_LIMIT_BYTES });
const installBodyLimit = bodyLimit({ maxSize: INSTALL_BODY_LIMIT_BYTES });

export function createRequestBodyLimitMiddleware(): MiddlewareHandler {
	return (c, next) => {
		if (
			c.req.path === "/api/install" ||
			c.req.path.startsWith("/api/install/")
		) {
			return installBodyLimit(c, next);
		}
		return defaultBodyLimit(c, next);
	};
}
