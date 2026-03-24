// @vitest-environment jsdom

import React, { type ComponentType, createElement } from "react";
import {
  cleanup,
  render,
  screen
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorldFixture
} from "./helpers/fixtures.js";
import {
  createJsonResponse,
  installFetchStub
} from "./helpers/fetch-stub.js";
import { loadWebModule } from "./helpers/load-web-module.js";

interface WorldsPanelProps {
  runtimeBaseUrl: string;
  onOpenWorld?(worldId: string): void;
}

interface WorldsPanelModule {
  WorldsPanel: ComponentType<WorldsPanelProps>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("apps/web WorldsPanel", () => {
  it("lists existing worlds and creates a new world through the runtime host", async () => {
    const { WorldsPanel } = await loadWebModule<WorldsPanelModule>("components/worlds-panel.ts");
    const existingWorld = createWorldFixture();
    const createdWorld = createWorldFixture({
      id: "world_02",
      name: "Sunmere",
      description: "Flooded ruins"
    });
    const fetchStub = installFetchStub([
      {
        method: "GET",
        url: "http://runtime.test/worlds",
        handler: async () => createJsonResponse([existingWorld])
      },
      {
        method: "POST",
        url: "http://runtime.test/worlds",
        handler: async () => createJsonResponse(createdWorld, { status: 201 })
      }
    ]);
    const user = userEvent.setup();

    render(createElement(WorldsPanel, {
      runtimeBaseUrl: "http://runtime.test"
    }));

    await screen.findByText("Northreach");
    await user.type(screen.getByLabelText("World name"), "Sunmere");
    await user.type(screen.getByLabelText("World description"), "Flooded ruins");
    await user.click(screen.getByRole("button", { name: "Create world" }));

    expect(await screen.findByText("Sunmere")).toBeTruthy();
    await expect(fetchStub.calls[1]?.json()).resolves.toEqual({
      name: "Sunmere",
      description: "Flooded ruins"
    });

    fetchStub.restore();
  });

  it("emits the selected world id when the user opens a world", async () => {
    const { WorldsPanel } = await loadWebModule<WorldsPanelModule>("components/worlds-panel.ts");
    const onOpenWorld = vi.fn();
    const fetchStub = installFetchStub([
      {
        method: "GET",
        url: "http://runtime.test/worlds",
        handler: async () => createJsonResponse([createWorldFixture()])
      }
    ]);
    const user = userEvent.setup();

    render(createElement(WorldsPanel, {
      runtimeBaseUrl: "http://runtime.test",
      onOpenWorld
    }));

    await screen.findByText("Northreach");
    await user.click(screen.getByRole("button", { name: "Open Northreach" }));

    expect(onOpenWorld).toHaveBeenCalledWith("world_01");

    fetchStub.restore();
  });
});
