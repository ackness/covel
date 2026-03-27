import { createRuntimeServer } from "./server.js";
import { createRuntimeComposition } from "./composition.js";
import { loadProjectEnvFile } from "./load-env-file.js";
import { resolveRuntimeListenConfig } from "./runtime-host.js";

loadProjectEnvFile({
  preserveShellDatabaseUrl: true
});

const { host, port } = resolveRuntimeListenConfig(process.env);

const runtime = await createRuntimeComposition({
  env: process.env
});

const server = createRuntimeServer({
  flowEngine: runtime.flowEngine,
  commandRegistry: runtime.commandRegistry,
  repositories: runtime.repositories,
  packageRuntime: runtime.packageRuntime,
  presetMetadataStore: runtime.presetMetadataStore,
  archiveService: runtime.archiveService
});

server.listen(port, host, () => {
  console.log(`covel runtime listening on http://${host}:${port}`);
});
