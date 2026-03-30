import { serve } from "@hono/node-server";
import dotenv from "dotenv";

dotenv.config({ path: "../../.env" });

import { app } from "./app.js";

const port = Number(process.env.SERVER_PORT) || 3001;

console.log(`Starting server on port ${port}...`);

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`Server running at http://localhost:${info.port}`);
  },
);
