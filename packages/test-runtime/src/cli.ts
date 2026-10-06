#!/usr/bin/env -S node --import tsx

import { runCli } from "./run-cli.js";

process.exitCode = await runCli(process.argv.slice(2));
