// @vitest-environment jsdom

import React, { type ComponentType, createElement } from "react";
import {
  cleanup,
  render,
  screen
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ArchiveVersion } from "../../../modules/contracts/src/index.js";
import {
  createArchiveVersionFixture
} from "./helpers/fixtures.js";
import { loadWebModule } from "./helpers/load-web-module.js";

interface ArchiveRestoreSummaryProps {
  archive: ArchiveVersion;
  onRestore(mode: "restore-in-place" | "restore-as-fork"): void;
}

interface ArchiveRestoreSummaryModule {
  ArchiveRestoreSummary: ComponentType<ArchiveRestoreSummaryProps>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("apps/web ArchiveRestoreSummary", () => {
  it("renders archive and working summaries and exposes both restore actions", async () => {
    const { ArchiveRestoreSummary } = await loadWebModule<ArchiveRestoreSummaryModule>(
      "components/archive-restore-summary.ts"
    );
    const onRestore = vi.fn();
    const user = userEvent.setup();

    render(createElement(ArchiveRestoreSummary, {
      archive: createArchiveVersionFixture(),
      onRestore
    }));

    expect(screen.getByText("第一幕总结：抵达北境哨塔，找到地窖入口。")).toBeTruthy();
    expect(screen.getByText("队伍已经登上哨塔，并确认了下一步进入地窖。")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Restore in place" }));
    await user.click(screen.getByRole("button", { name: "Restore as fork" }));

    expect(onRestore).toHaveBeenNthCalledWith(1, "restore-in-place");
    expect(onRestore).toHaveBeenNthCalledWith(2, "restore-as-fork");
  });
});
