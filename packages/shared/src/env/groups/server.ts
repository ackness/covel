import type { EnvVarDefinition } from "../types.js";

export const SERVER_ENV_VARS = [
  {
    name: "SERVER_PORT",
    group: "server",
    type: "integer",
    status: "active",
    defaultValue: "3001",
    description: "HTTP server listen port.",
  },
  {
    name: "COVEL_BIND_HOST",
    group: "server",
    type: "string",
    status: "active",
    defaultValue: "127.0.0.1",
    description:
      "HTTP server listen host. Defaults to loopback so local/desktop deployments are not reachable from the network. Set to 0.0.0.0 explicitly for containers or hosted deployments.",
  },
  {
    name: "COVEL_ALLOWED_HOSTS",
    group: "server",
    type: "string",
    status: "active",
    description:
      "Comma-separated host names, besides localhost, 127.0.0.1 and [::1], that a request on the self tier may name in its Host header. List the names a self-hosted web app is opened by from other machines; any other Host is refused, which stops DNS rebinding. demo, commercial and the browser-private form (production on STORE_BACKEND=memory) refuse to start with it, since they skip the check.",
  },
  {
    name: "COVEL_SOURCE_REPOSITORY",
    group: "server",
    type: "url",
    status: "active",
    example: "https://github.com/ackness/covel",
    description:
      "Public https address of the source repository this server was built from. /api/health reports it, and the web app's notice on a shared server links to it so players can read the code.",
  },
  {
    name: "COVEL_SOURCE_COMMIT",
    group: "server",
    type: "string",
    status: "active",
    description:
      "Git commit (7 to 40 hex digits) this server was built from, reported by /api/health. When unset, RENDER_GIT_COMMIT is used.",
  },
  {
    name: "RENDER_GIT_COMMIT",
    group: "server",
    type: "string",
    status: "active",
    description:
      "Set by Render on every deploy: the commit being deployed. Read only as the fallback for COVEL_SOURCE_COMMIT.",
  },
  {
    name: "NODE_ENV",
    group: "server",
    type: "enum",
    status: "active",
    values: ["development", "production", "test"],
    defaultValue: "development",
    description: "Node runtime mode used by logging and diagnostics.",
  },
  {
    name: "SERVE_STATIC",
    group: "server",
    type: "boolean",
    status: "active",
    defaultValue: "false",
    description: "Serve built web assets from the server process.",
  },
  {
    name: "STATIC_DIR",
    group: "server",
    type: "path",
    status: "active",
    defaultValue: "./web-dist",
    description: "Directory served when SERVE_STATIC is enabled.",
  },
  {
    name: "DEPLOYMENT_TIER",
    group: "server",
    type: "enum",
    status: "active",
    values: ["self", "demo", "commercial"],
    defaultValue: "self",
    description:
      "Deployment form: the server turns it into its host profile once at start. Any other value stops the start.",
  },
  {
    name: "CORS_ORIGIN",
    group: "server",
    type: "string",
    status: "active",
    description: "Comma-separated HTTP origins allowed by CORS.",
  },
  {
    name: "ENABLE_DEBUG_PAGE",
    group: "server",
    type: "boolean",
    status: "active",
    defaultValue: "false",
    description: "Enables debug and internal routes in production.",
  },
  {
    name: "RATE_LIMIT_RPM",
    group: "server",
    type: "integer",
    status: "active",
    defaultValue: "60",
    description:
      "Per-IP requests per minute for GET /api/events/stream only. Other rate-limited routes set their own quota in code.",
  },
  {
    name: "TRUSTED_PROXY_IPS",
    group: "server",
    type: "string",
    status: "active",
    description:
      "Comma-separated proxy IP allowlist used before trusting X-Forwarded-For / X-Real-IP for rate limiting.",
  },
  {
    name: "COVEL_MEDIA_TOKEN_SECRET",
    group: "server",
    type: "secret",
    status: "active",
    secret: true,
    description:
      "HMAC-SHA256 secret used to sign /api/media/:id short-lived URLs (5min TTL). Required in production; dev generates a per-process random secret if absent.",
  },
  {
    name: "COVEL_MEDIA_CLEANUP_ENABLED",
    group: "server",
    type: "boolean",
    status: "active",
    defaultValue: "false",
    description:
      "Enables the destructive POST /api/media/cleanup endpoint. Off by default; DEPLOYMENT_TIER=commercial keeps the endpoint closed and refuses to start with it.",
  },
  {
    name: "COVEL_INSTALL_API_ENABLED",
    group: "server",
    type: "boolean",
    status: "active",
    defaultValue: "false",
    description:
      "Explicit production opt-in for plugin/world package filesystem mutations (install and plugin uninstall) when no desktop bearer token is configured.",
  },
  {
    name: "COVEL_SUSPENSION_TTL_MS",
    group: "server",
    type: "integer",
    status: "active",
    defaultValue: "604800000",
    description:
      "TTL (ms) after which an UNRESOLVED suspension is swept by the startup + opportunistic cleanup. Default 604800000 (7 days). Set to 0 (or negative) to disable sweeping. Claimed (in-flight) and successfully-resolved suspensions are never swept.",
  },
  {
    name: "APP_PORT",
    group: "server",
    type: "integer",
    status: "active",
    defaultValue: "3001",
    description: "Host port for the Docker Compose app service.",
  },
  {
    name: "COVEL_LOG_QUIET_PATHS",
    group: "server",
    type: "string",
    status: "active",
    defaultValue: "/api/health",
    description:
      "Comma-separated request paths the Hono request logger skips, so health polling does not flood server.log.",
  },
] as const satisfies readonly EnvVarDefinition[];
