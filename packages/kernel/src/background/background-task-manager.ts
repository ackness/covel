import { randomUUID } from "node:crypto";
import type { BackgroundTask } from "../types.js";

/**
 * Manages background tasks spawned for low-priority runtimes.
 *
 * Background tasks run asynchronously — the main turn result returns
 * immediately without waiting for them. Results are delivered via
 * the onDone callback and can be picked up by follow-up events.
 */
export interface BackgroundTaskManager {
  /** Enqueue a new background task. Returns the task object. */
  enqueue(
    runtimeId: string,
    pluginId: string,
    description: string,
    executor: () => Promise<{
      text: string;
      proposals: Array<{ kind: string; payload: unknown }>;
    }>
  ): BackgroundTask;

  /** Get all tasks (snapshot). */
  getAll(): readonly BackgroundTask[];

  /** Get pending/running tasks. */
  getActive(): readonly BackgroundTask[];

  /** Get completed tasks since last drain. */
  drainCompleted(): BackgroundTask[];
}

export function createBackgroundTaskManager(
  onDone?: (task: BackgroundTask) => void | Promise<void>
): BackgroundTaskManager {
  const tasks = new Map<string, BackgroundTask>();
  let completedQueue: BackgroundTask[] = [];

  function enqueue(
    runtimeId: string,
    pluginId: string,
    description: string,
    executor: () => Promise<{
      text: string;
      proposals: Array<{ kind: string; payload: unknown }>;
    }>
  ): BackgroundTask {
    const task: BackgroundTask = {
      taskId: `bg-${randomUUID()}`,
      runtimeId,
      pluginId,
      status: "pending",
      description,
      startedAt: Date.now(),
    };

    tasks.set(task.taskId, task);

    // Fire and forget — run asynchronously
    void runTask(task, executor);

    return task;
  }

  async function runTask(
    task: BackgroundTask,
    executor: () => Promise<{
      text: string;
      proposals: Array<{ kind: string; payload: unknown }>;
    }>
  ): Promise<void> {
    const running = { ...task, status: "running" as const };
    tasks.set(task.taskId, running);

    let completed: BackgroundTask;
    try {
      const result = await executor();
      completed = { ...running, status: "completed" as const, result, completedAt: Date.now() };
    } catch (err) {
      completed = {
        ...running,
        status: "failed" as const,
        error: err instanceof Error ? err.message : String(err),
        completedAt: Date.now(),
      };
    }

    tasks.set(task.taskId, completed);
    completedQueue = [...completedQueue, completed];

    if (onDone) {
      try {
        await onDone(completed);
      } catch (err) {
        console.warn(`[background-task-manager] onDone callback failed for task "${task.taskId}":`, err);
      }
    }
  }

  function getAll(): readonly BackgroundTask[] {
    return [...tasks.values()];
  }

  function getActive(): readonly BackgroundTask[] {
    return [...tasks.values()].filter(
      (t) => t.status === "pending" || t.status === "running"
    );
  }

  function drainCompleted(): BackgroundTask[] {
    const drained = [...completedQueue];
    completedQueue = [];
    return drained;
  }

  return { enqueue, getAll, getActive, drainCompleted };
}
