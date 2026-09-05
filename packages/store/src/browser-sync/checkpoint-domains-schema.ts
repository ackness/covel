import { i18nTextSchema, worldDimensionsSchema } from "@covel/shared";
import { z } from "zod";
import {
  checkpointRecordArrays,
  jsonObject,
  nonEmptyString,
  stateChanges,
  stateEntries,
  stateSchemas,
  timestamp,
} from "./checkpoint-record-schemas.js";
import {
  checkpointLifecycleArrays,
  session,
  snapshotRecordArrays,
} from "./checkpoint-lifecycle-schemas.js";

const recordArrays = {
  ...checkpointRecordArrays,
  ...checkpointLifecycleArrays,
};
const state = z.looseObject({
  schemas: z.array(stateSchemas),
  entries: z.array(stateEntries),
  changes: z.array(stateChanges),
});

/** Validate every durable record before any checkpoint transaction starts. */
export const checkpointDomainsSchema = z
  .object({
    session,
    world: z
      .looseObject({
        id: nonEmptyString,
        name: i18nTextSchema,
        description: i18nTextSchema,
        lore: i18nTextSchema.optional(),
        tags: z.array(z.string()).optional(),
        locale: z.string().optional(),
        dimensions: worldDimensionsSchema.optional(),
        metadata: jsonObject.optional(),
        createdAt: timestamp,
        updatedAt: timestamp.optional(),
      })
      .nullable(),
    ...recordArrays,
    state: state.optional(),
  })
  .superRefine((checkpoint, context) => {
    const sessionId = checkpoint.session.id;
    const validateOwnership = (
      records: readonly { readonly sessionId: string }[],
      path: (string | number)[],
    ): void => {
      records.forEach((record, index) => {
        if (record.sessionId !== sessionId) {
          context.addIssue({
            code: "custom",
            path: [...path, index, "sessionId"],
            message: "must match checkpoint.sessionId",
          });
        }
      });
    };

    if (
      checkpoint.world &&
      checkpoint.world.id !== checkpoint.session.worldId
    ) {
      context.addIssue({
        code: "custom",
        path: ["world", "id"],
        message: "must match session.worldId",
      });
    }
    for (const key of Object.keys(
      recordArrays,
    ) as (keyof typeof recordArrays)[]) {
      validateOwnership(checkpoint[key], [key]);
    }
    if (checkpoint.state) {
      for (const key of ["schemas", "entries", "changes"] as const) {
        validateOwnership(checkpoint.state[key], ["state", key]);
      }
    }
    checkpoint.snapshots.forEach((snapshot, index) => {
      for (const key of Object.keys(
        snapshotRecordArrays,
      ) as (keyof typeof snapshotRecordArrays)[]) {
        validateOwnership(snapshot.payload[key] ?? [], [
          "snapshots",
          index,
          "payload",
          key,
        ]);
      }
    });
  });
