import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

const workflow = fs.readFileSync(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const resolve = parse(workflow).jobs.prepare.steps.find(
  (step) => step.id === "resolve",
).run;

test(
  "release source validation keeps matching workflows and gives branch/tag guidance",
  {
    skip:
      process.platform === "win32" &&
      "the release prepare job runs on Linux bash",
  },
  async (t) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "release-workflow-ref-"),
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const commit = (message) => {
      git("add", ".");
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        message,
      );
      return git("rev-parse", "HEAD");
    };
    git("init");
    fs.mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    const releaseFile = path.join(root, ".github/workflows/release.yml");
    fs.writeFileSync(releaseFile, workflow);
    fs.writeFileSync(path.join(root, ".github/workflows/ci.yml"), "name: CI\n");
    const base = commit("base workflows");
    git("branch", "old-source", base);
    git("tag", "v0.1.0", base);
    fs.writeFileSync(
      path.join(root, "source.txt"),
      "another source revision\n",
    );
    const sourceOnly = commit("same workflows, other source");
    fs.appendFileSync(releaseFile, "\n# Different workflow controls\n");
    const controls = commit("different release workflow");

    for (const sample of [
      {
        name: "same commit",
        source: controls,
        run: controls,
        input: "",
        allowed: true,
      },
      {
        name: "same workflows",
        source: sourceOnly,
        run: base,
        input: sourceOnly,
        allowed: true,
      },
      {
        name: "SHA with other workflows",
        source: base,
        run: controls,
        input: base,
        allowed: false,
      },
      {
        name: "branch with other workflows",
        source: base,
        run: controls,
        input: "old-source",
        allowed: false,
      },
      {
        name: "tag with other workflows",
        source: base,
        run: controls,
        input: "v0.1.0",
        allowed: false,
      },
    ]) {
      await t.test(sample.name, () => {
        git("checkout", "--detach", sample.source);
        const output = path.join(root, "github-output");
        fs.rmSync(output, { force: true });
        const result = spawnSync("bash", ["-c", resolve], {
          cwd: root,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            GITHUB_SHA: sample.run,
            INPUT_TAG: sample.input,
            EVENT_NAME: "workflow_dispatch",
            EVENT_TAG: "",
            PUBLISH_INPUT: "false",
            GITHUB_OUTPUT: output,
          },
        });
        assert.ifError(result.error);
        assert.equal(result.status, sample.allowed ? 0 : 1, result.stderr);
        if (sample.allowed) {
          assert.match(
            fs.readFileSync(output, "utf8"),
            new RegExp(`commit=${sample.source}\\npublish=false`),
          );
        } else {
          assert.match(
            result.stdout,
            /gh workflow run release\.yml --ref <branch-or-tag>/,
          );
          assert.match(result.stdout, /--ref argument cannot be a commit SHA/);
          assert.ok(!result.stdout.includes(`--ref ${base}`));
          assert.ok(!fs.existsSync(output));
        }
      });
    }
  },
);
