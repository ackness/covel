import type { EnvVarDefinition } from "../types.js";

export const STORAGE_ENV_VARS = [
  {
    name: "STORE_BACKEND",
    group: "storage",
    type: "enum",
    status: "active",
    values: ["memory", "sqlite", "pg"],
    defaultValue: "sqlite",
    example: "sqlite",
    description:
      "Server DataStore backend. Browser callers can use idb through @covel/store createStore().",
  },
  {
    name: "SQLITE_PATH",
    group: "storage",
    type: "path",
    status: "active",
    defaultValue: "./data/covel.db",
    description: "SQLite database path for the server store.",
  },
  {
    name: "DATABASE_URL",
    group: "storage",
    type: "url",
    status: "active",
    example: "postgresql://covel:covel_dev@localhost:5432/covel",
    description: "PostgreSQL connection string for the pg store and Drizzle.",
  },
  {
    name: "MEDIA_BACKEND",
    group: "storage",
    type: "enum",
    status: "active",
    values: ["mirror", "memory", "sqlite", "pg", "none"],
    defaultValue: "mirror",
    example: "mirror",
    description:
      "Server MediaStore backend. mirror follows STORE_BACKEND; none disables media routes.",
  },
  {
    name: "MEDIA_ROOT",
    group: "storage",
    type: "path",
    status: "active",
    description:
      "Filesystem root for sqlite media blobs. Defaults to a media directory beside SQLITE_PATH.",
  },
  {
    name: "VECTOR_BACKEND",
    group: "storage",
    type: "enum",
    status: "active",
    values: ["embedded", "none", "external"],
    defaultValue: "embedded",
    example: "embedded",
    description:
      "VectorStore backend. embedded uses the active DataStore vector capability; none disables vector search; external is reserved for an injected adapter.",
  },
  {
    name: "COVEL_PG_LOCK_POOL_MAX",
    group: "storage",
    type: "integer",
    status: "active",
    defaultValue: "16",
    description:
      "Max connections in the dedicated PG advisory session-lock pool. Each in-flight turn holds one reserved connection; size at least at expected peak concurrent sessions per pod.",
  },
  {
    name: "POSTGRES_USER",
    group: "storage",
    type: "string",
    status: "active",
    defaultValue: "covel",
    description: "Docker Compose PostgreSQL username.",
  },
  {
    name: "POSTGRES_PASSWORD",
    group: "storage",
    type: "secret",
    status: "active",
    secret: true,
    description: "Docker Compose PostgreSQL password.",
  },
  {
    name: "POSTGRES_DB",
    group: "storage",
    type: "string",
    status: "active",
    defaultValue: "covel",
    description: "Docker Compose PostgreSQL database name.",
  },
  {
    name: "POSTGRES_PORT",
    group: "storage",
    type: "integer",
    status: "active",
    defaultValue: "5432",
    description: "Host port for the Docker Compose PostgreSQL service.",
  },
] as const satisfies readonly EnvVarDefinition[];
