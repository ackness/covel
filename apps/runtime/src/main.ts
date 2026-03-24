import { createRuntimeServer } from "./server.js";
import { createRuntimeComposition } from "./composition.js";

const port = Number(process.env.PORT ?? 8787);

const runtime = await createRuntimeComposition({
  env: process.env
});

const server = createRuntimeServer({
  flowEngine: runtime.flowEngine,
  repositories: runtime.repositories,
  packageRuntime: runtime.packageRuntime,
  archiveService: runtime.archiveService
});

server.listen(port, "0.0.0.0", () => {
  console.log(`covel runtime listening on http://0.0.0.0:${port}`);
});
