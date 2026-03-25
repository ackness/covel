import { createRuntimeServer } from "./server.js";
import { createRuntimeComposition } from "./composition.js";
import { resolveRuntimeListenConfig } from "./runtime-host.js";

const { host, port } = resolveRuntimeListenConfig(process.env);

const runtime = await createRuntimeComposition({
  env: process.env
});

const server = createRuntimeServer({
  flowEngine: runtime.flowEngine,
  repositories: runtime.repositories,
  packageRuntime: runtime.packageRuntime,
  presetMetadataStore: runtime.presetMetadataStore,
  archiveService: runtime.archiveService
});

server.listen(port, host, () => {
  console.log(`covel runtime listening on http://${host}:${port}`);
});
