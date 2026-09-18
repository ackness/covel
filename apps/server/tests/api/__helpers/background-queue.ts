import { afterEach } from "vitest";
import {
  createPluginBackgroundQueue,
  type PluginBackgroundQueue,
} from "../../../src/routes/api/plugin-rpc/background-queue.js";

const queues = new Set<PluginBackgroundQueue>();

afterEach(async () => {
  const closing = [...queues].map((queue) => queue.close());
  queues.clear();
  await Promise.all(closing);
});

export function createTestBackgroundQueue(): PluginBackgroundQueue {
  const queue = createPluginBackgroundQueue();
  queues.add(queue);
  return queue;
}
