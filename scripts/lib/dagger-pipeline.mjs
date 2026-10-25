import { isSha, repository } from "./dagger-pr-policy.mjs";

const nodeImage =
  "node:26.12.1-bookworm@sha256:155f6779f557f863b16a6b77b3443b52f7dde209643eff9896d661bbd6829840";
const pgImage =
  "pgvector/pgvector:0.8.7-pg18@sha256:2358fcba361ed2233a5ed81b5fe4ca779ccb304120ce531a3bf51c0ed7e2bc11";
const q = JSON.stringify;
const field = (name, args) => `${name}(${args})`;
const exec = (args, any = false) =>
  field(
    "withExec",
    `args:${q(args)},disableDaggerInDagger:true${any ? ",expect:ANY" : ""}`,
  );
const env = (name, value) =>
  field("withEnvVariable", `name:${q(name)},value:${q(value)}`);
const query = (chain, leaf) =>
  `{ ${chain.join(" { ")} { ${leaf} ${"}".repeat(chain.length)} }`;

export function tasksForScope(scope) {
  if (!["docs", "full"].includes(scope)) throw new Error("Invalid CI scope");
  return scope === "docs"
    ? ["verify", "site"]
    : ["verify", "server", "tests", "web", "postgres", "browser", "site"];
}

export function postgresQuery(nonce) {
  return query(
    [
      'container(platform:"linux/amd64")',
      field("from", `address:${q(pgImage)}`),
      env("POSTGRES_USER", "covel"),
      env("POSTGRES_PASSWORD", "covel_ci"),
      env("POSTGRES_DB", "covel"),
      env("CI_RUN", nonce),
      "withExposedPort(port:5432)",
      "asService(disableDaggerInDagger:true)",
    ],
    "id",
  );
}

/** Commands are fixed by the trusted workflow; source is fetched inside the engine. */
export function pipelineQuery({
  sha,
  scope,
  task,
  nonce,
  postgresId,
  artifactDir,
}) {
  if (!isSha(sha) || !tasksForScope(scope).includes(task) || !nonce)
    throw new Error("Invalid pipeline input");
  const chain = [
    'container(platform:"linux/amd64")',
    field("from", `address:${q(nodeImage)}`),
    exec([
      "bash",
      "-ec",
      "npm install -g pnpm@12.14.0; " +
        "curl -fsSL https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz -o /tmp/actionlint.tar.gz; " +
        "echo '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8  /tmp/actionlint.tar.gz' | sha256sum -c -; " +
        "tar -xzf /tmp/actionlint.tar.gz -C /usr/local/bin actionlint",
    ]),
    exec([
      "bash",
      "-ec",
      `git init /src; cd /src; git remote add origin https://github.com/${repository}.git; git fetch --depth=1 origin ${sha}; git checkout --detach FETCH_HEAD`,
    ]),
    'withWorkdir(path:"/src")',
    env("CI", "true"),
    env("TURBO_CONCURRENCY", "3"),
    env("TURBO_CACHE_MAX_AGE", "2d"),
    env("TURBO_CACHE_MAX_SIZE", "500MB"),
    exec(["pnpm", "install", "--frozen-lockfile"]),
  ];
  if (task === "tests")
    chain.push(
      exec([
        "bash",
        "-ec",
        "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 && rm -rf /var/lib/apt/lists/*",
      ]),
    );
  if (task === "browser")
    chain.push(
      exec([
        "pnpm",
        "exec",
        "playwright",
        "install",
        "--with-deps",
        "chromium",
      ]),
    );
  // Keep dependency/image layers reusable, but always execute verification.
  // Database/browser state and network fixtures cannot be proven by cached tests.
  chain.push(
    env("CI_RUN", nonce),
    env("VITEST_MAX_WORKERS", task === "tests" ? "2" : "4"),
  );
  if (task === "postgres") {
    if (!postgresId)
      throw new Error("PostgreSQL task requires a database service");
    chain.push(
      field("withServiceBinding", `alias:"postgres",service:${q(postgresId)}`),
      env("DATABASE_URL", "postgresql://covel:covel_ci@postgres:5432/covel"),
      env("COVEL_REQUIRE_PG_TESTS", "1"),
    );
  }
  if (task === "site") chain.push(env("SITE_BASE", "/covel/"));
  const commands = {
    verify:
      "pnpm check" + (scope === "docs" ? " && pnpm test:docs:packages" : ""),
    tests:
      "pnpm test --concurrency=2 --filter=!@covel/web --filter=!@covel/server --filter=!@covel/runtime && " +
      "pnpm build --cache=local:r --filter=!@covel/docs --filter=!@covel/site",
    web: "pnpm test --filter=@covel/web",
    server: "pnpm test --filter=@covel/server && pnpm test:coverage:runtime",
    postgres: "pnpm test:pg",
    browser: "pnpm e2e --list && pnpm e2e:smoke && pnpm e2e:extensions",
    site:
      "pnpm exec turbo build --filter=@covel/site --filter=@covel/docs --concurrency=2 && " +
      "rm -rf apps/site/dist/docs && cp -R apps/docs/dist apps/site/dist/docs",
  };
  let command = commands[task];
  let leaf = "exitCode";
  if (task === "browser") {
    if (!artifactDir)
      throw new Error("Browser task requires an artifact directory");
    command =
      `(${command}); result=$?; mkdir -p /ci-artifacts; ` +
      "for dir in tests/e2e/artifacts tests/e2e/report; do " +
      'if [ -d "$dir" ]; then cp -R "$dir" /ci-artifacts/; fi; done; exit "$result"';
    leaf += ` directory(path:"/ci-artifacts") { export(path:${q(artifactDir)}) }`;
  }
  chain.push(exec(["bash", "-c", command], true));
  return query(chain, leaf);
}

export function queryLeaf(data) {
  while (data && typeof data === "object" && !Array.isArray(data)) {
    if ("exitCode" in data || "id" in data) return data;
    const values = Object.values(data);
    if (values.length !== 1)
      throw new Error("Unexpected Dagger response shape");
    data = values[0];
  }
  throw new Error("Missing Dagger result");
}
