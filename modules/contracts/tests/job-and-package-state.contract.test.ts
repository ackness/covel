import { describe, it } from "vitest";

import {
  JobRecordSchema,
  PackageStateRecordSchema
} from "../src/index.js";
import {
  expectSchemaAccepts,
  expectSchemaRejects
} from "./helpers.js";

describe("PackageStateRecordSchema", () => {
  it("accepts a package-scoped state record", () => {
    expectSchemaAccepts(PackageStateRecordSchema, {
      scope: "session",
      ownerId: "ses_01",
      packageName: "director-choices",
      collection: "choice_state",
      key: "pending:turn_01",
      value: {
        selected: "opt_a"
      },
      updatedAt: "2026-03-25T12:00:00Z"
    });
  });

  it("rejects package state records without routing fields", () => {
    expectSchemaRejects(PackageStateRecordSchema, {
      scope: "session",
      value: {}
    });
  });
});

describe("JobRecordSchema", () => {
  it("accepts a queued job record", () => {
    expectSchemaAccepts(JobRecordSchema, {
      id: "job_01",
      packageName: "story-image",
      jobType: "scene-image",
      sessionId: "ses_01",
      status: "queued",
      input: {
        scene: "Northreach"
      },
      attempt: 0,
      createdAt: "2026-03-25T12:00:00Z"
    });
  });

  it("accepts completed jobs with output metadata", () => {
    expectSchemaAccepts(JobRecordSchema, {
      id: "job_02",
      packageName: "story-voice",
      jobType: "narration-tts",
      status: "completed",
      input: {
        messageId: "msg_01"
      },
      output: {
        artifactId: "art_01"
      },
      attempt: 1,
      createdAt: "2026-03-25T12:00:00Z",
      startedAt: "2026-03-25T12:00:01Z",
      completedAt: "2026-03-25T12:00:10Z"
    });
  });

  it("rejects jobs without execution payloads", () => {
    expectSchemaRejects(JobRecordSchema, {
      id: "job_03",
      packageName: "story-image",
      jobType: "scene-image",
      status: "queued",
      attempt: 0,
      createdAt: "2026-03-25T12:00:00Z"
    });
  });
});
