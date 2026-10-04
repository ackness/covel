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
});
