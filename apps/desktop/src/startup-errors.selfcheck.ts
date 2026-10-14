import assert from "node:assert/strict";
import { setDesktopLocaleFromSettings } from "./main-i18n.js";
import { diagnoseStartupError } from "./startup-errors.js";

setDesktopLocaleFromSettings({ "ui.locale": "en-US" });

// The sidecar exits on a refused database; the reason is only in its stderr.
const refused = diagnoseStartupError(
  new Error("Server exited before readiness (code=1, signal=null)"),
  {
    logs: [
      "file:///app/server.mjs:10",
      "StoreSchemaVersionError: The SQLite database was written by a newer Covel (data schema 5; this version uses 4). Back up the database file.",
      "    at createTables (file:///app/server.mjs:20:5)",
    ].join("\n"),
    dataRoot: "/data/covel",
    configTomlPath: "/home/me/.covel/config.toml",
  },
);
assert.equal(refused.title, "Data from another Covel version");
assert.match(refused.detail, /^The SQLite database was written by a newer/);
assert.match(refused.hint ?? "", /\/data\/covel/);
assert.match(refused.hint ?? "", /\/home\/me\/\.covel\/config\.toml/);

const other = diagnoseStartupError(new Error("listen EADDRINUSE :::3001"), {
  logs: "something else",
});
assert.equal(other.title, "Port conflict");

console.log("startup-errors selfcheck: OK");
