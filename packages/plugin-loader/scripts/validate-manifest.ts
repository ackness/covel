#!/usr/bin/env tsx
import { runValidateManifest } from "./run-validate-manifest.js";

process.exitCode = await runValidateManifest(process.argv.slice(2));
