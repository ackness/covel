import {
  createEventDirectory,
  type EventDirectory,
  type EventDirectoryDeps,
} from "@covel/tools";

export type TestEventDirectory = EventDirectory;
export type TestEventDirectoryDeps = EventDirectoryDeps;

export function createTestEventDirectory(
  deps: TestEventDirectoryDeps,
): TestEventDirectory {
  return createEventDirectory(deps);
}
