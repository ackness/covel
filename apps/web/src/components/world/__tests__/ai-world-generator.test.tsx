import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerateWorldEvent, WorldRecord } from "@/services/api.js";

const api = vi.hoisted(() => ({
  fetchServerHealth: vi.fn(async () => ({ storage: undefined })),
  generateWorld: vi.fn(),
  listGeneratableWorldContent: vi.fn(
    async (): Promise<
      {
        contract: string;
        title: string;
        description?: string;
        selectedByDefault: boolean;
      }[]
    > => [],
  ),
}));
const dataService = vi.hoisted(() => ({
  saveGeneratedWorld: vi.fn(),
}));

vi.mock("@/services/api.js", () => api);
vi.mock("@/services/data-service.js", () => ({
  generatedWorldSaveTargetForStorageMode: vi.fn(() => "return-only"),
  getDataService: vi.fn(() => dataService),
  getStorageMode: vi.fn(() => "local"),
  storageModeForServerStorage: vi.fn(() => "local"),
}));

const { AiWorldGenerator } = await import("../ai-world-generator.js");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AiWorldGenerator", () => {
  it("ignores a local save that finishes after the player cancels", async () => {
    let onEvent: ((event: GenerateWorldEvent) => void) | undefined;
    api.generateWorld.mockImplementation(
      (
        _prompt: string,
        _locale: string,
        next: (event: GenerateWorldEvent) => void,
      ) => {
        onEvent = next;
        return new AbortController();
      },
    );
    let finishSave: ((world: WorldRecord) => void) | undefined;
    dataService.saveGeneratedWorld.mockReturnValue(
      new Promise<WorldRecord>((resolve) => {
        finishSave = resolve;
      }),
    );
    const onWorldCreated = vi.fn();

    render(
      <AiWorldGenerator
        open
        onOpenChange={vi.fn()}
        onWorldCreated={onWorldCreated}
      />,
    );
    fireEvent.change(screen.getByLabelText("核心创意"), {
      target: { value: "A world built from promises" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始构筑" }));
    await waitFor(() => expect(api.generateWorld).toHaveBeenCalledOnce());

    const world = {
      id: "generated-world",
      name: "Generated World",
      description: "",
    } as WorldRecord;
    act(() => onEvent?.({ type: "done", world }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await act(async () => {
      finishSave?.(world);
      await Promise.resolve();
    });

    expect(onWorldCreated).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole("button", {
          name: "开始构筑",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("offers the plugin content the server lists and sends the selection", async () => {
    api.listGeneratableWorldContent.mockResolvedValue([
      {
        contract: "memory.blocks@1",
        title: "Memory blocks",
        description: "World-defined memory blocks.",
        selectedByDefault: true,
      },
      {
        contract: "world.time-definition@1",
        title: "World time definition",
        selectedByDefault: false,
      },
    ]);
    api.generateWorld.mockReturnValue(new AbortController());

    render(
      <AiWorldGenerator open onOpenChange={vi.fn()} onWorldCreated={vi.fn()} />,
    );
    const memory = await screen.findByRole("button", {
      name: /Memory blocks/,
    });
    const time = screen.getByRole("button", { name: /World time definition/ });
    expect(memory.getAttribute("aria-pressed")).toBe("true");
    expect(time.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(memory);
    fireEvent.click(time);
    fireEvent.change(screen.getByLabelText("核心创意"), {
      target: { value: "A harbor that keeps time by the tide" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始构筑" }));

    await waitFor(() => expect(api.generateWorld).toHaveBeenCalledOnce());
    const options = api.generateWorld.mock.calls[0]![5] as {
      brief: { content: string[]; contracts?: string[] };
    };
    expect(options.brief.contracts).toEqual(["world.time-definition@1"]);
    expect(options.brief.content).not.toContain("memory");
  });

  /** Start a generation and return the function that feeds server events. */
  async function startGeneration(onOpenChange = vi.fn()) {
    let onEvent: ((event: GenerateWorldEvent) => void) | undefined;
    api.generateWorld.mockImplementation(
      (
        _prompt: string,
        _locale: string,
        next: (event: GenerateWorldEvent) => void,
      ) => {
        onEvent = next;
        return new AbortController();
      },
    );
    render(
      <AiWorldGenerator
        open
        onOpenChange={onOpenChange}
        onWorldCreated={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("核心创意"), {
      target: { value: "A harbor that keeps time by the tide" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始构筑" }));
    await waitFor(() => expect(api.generateWorld).toHaveBeenCalledOnce());
    return (event: GenerateWorldEvent) => act(() => onEvent?.(event));
  }

  it("shows each part of the world as the server reports it", async () => {
    const send = await startGeneration();
    send({
      type: "progress",
      phase: "generating",
      parts: [
        { id: "manifest", state: "done", attempt: 1, chars: 1800 },
        { id: "lore", state: "active", attempt: 2, chars: 412 },
        { id: "characters", state: "pending" },
        { id: "contract:memory.blocks@1", title: "记忆板块", state: "failed" },
      ],
    });

    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-state"))).toEqual([
      "done",
      "active",
      "pending",
      "failed",
    ]);
    expect(rows.map((row) => row.textContent)).toEqual([
      "世界设定",
      "世界背景已写 412 字 · 第 2 次尝试",
      "主要角色",
      "记忆板块未能生成",
    ]);

    // The part that stopped the world stays on screen with the error.
    send({
      type: "error",
      message: "LLM error: The model sent no output for 120 seconds",
      code: "model_idle_timeout",
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText(/世界创作：等待模型的时间/)).toBeTruthy();
  });

  it("keeps a world that falls short of the brief on screen until the player closes it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const onOpenChange = vi.fn();
      const send = await startGeneration(onOpenChange);
      const world = {
        id: "generated-world",
        name: "Generated World",
        description: "",
      } as WorldRecord;
      dataService.saveGeneratedWorld.mockResolvedValue(world);
      send({
        type: "done",
        world,
        warnings: ["characters could not be generated: LLM error"],
      });

      expect(
        await screen.findByText("characters could not be generated: LLM error"),
      ).toBeTruthy();
      // A world without gaps closes the dialog by itself after 900 ms.
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(onOpenChange).not.toHaveBeenCalled();

      // The dialog has its own close control; the footer button is the last.
      fireEvent.click(screen.getAllByRole("button", { name: "关闭" }).at(-1)!);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
