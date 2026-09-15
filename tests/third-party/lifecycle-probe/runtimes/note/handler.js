import { record } from "../../lib/record.js";

export default async function (ctx) {
  if (ctx.userSettings?.enabled === false) {
    return { outcome: "success", value: { skipped: true } };
  }
  return record(ctx, "note");
}
