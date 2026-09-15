import { record } from "../../lib/record.js";

export default async function (ctx) {
  return record(ctx, "background");
}
