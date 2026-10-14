import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionPlugin } from "@/services/api.js";
import i18n from "@/i18n";
import { requestConfirm } from "@/lib/confirm-channel.js";
import { ConfirmHost } from "@/components/ui/confirm-host.js";
import { postPluginRpcWithApproval } from "../../plugin-rpc-ui.js";
import { useImageGeneration } from "../use-image-generation.js";

vi.mock("@/services/api/request.js", () => ({
  request: vi.fn(async () => ({
    flow: {
      pluginId: "pictures",
      entryRuntimeId: "pictures/prompt",
      assetRuntimeIds: ["pictures/draw"],
    },
  })),
}));
vi.mock("../../plugin-rpc-ui.js", () => ({
  postPluginRpcWithApproval: vi.fn(),
  emitPluginRpcRuntimeResponse: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const plugins: SessionPlugin[] = [
  {
    id: "pictures",
    displayName: "Pictures",
    description: "",
    kind: "plugin",
    source: "community",
    hostState: "loaded",
    runtimeCount: 0,
    provides: [],
    requires: [],
    optional: [],
    conflicts: [],
    extensions: [],
    eventTopics: [],
    tags: [],
    runtimes: [],
    tools: [],
    userSettings: [],
    languages: { text: ["en"], instructions: ["en"] },
    active: true,
    serverCodeApproved: true,
    sessionState: "active",
    locked: false,
  },
];

it("queues image approval behind another global confirmation and translates the action name", async () => {
  vi.mocked(postPluginRpcWithApproval).mockImplementation(
    async ({ confirm, actionLabel }) => {
      await confirm({
        title: actionLabel,
        message: "Allow image generation?",
        confirmLabel: "Allow image",
        cancelLabel: "Cancel image",
      });
      return null;
    },
  );
  render(<ConfirmHost />);
  let first!: Promise<boolean>;
  act(() => {
    first = requestConfirm({
      title: "Existing request",
      message: "Review this first",
      confirmLabel: "Proceed",
      cancelLabel: "Cancel existing",
    });
  });
  const hook = renderHook(() =>
    useImageGeneration({
      sessionPlugins: plugins,
      sessionId: "session",
      t: i18n.t,
    }),
  );
  await waitFor(() => expect(hook.result.current.isImageGenActive).toBe(true));
  let generated!: Promise<void>;
  act(() => {
    generated = hook.result.current.handleGenerateImage();
  });
  expect(
    vi.mocked(postPluginRpcWithApproval).mock.calls.at(-1)?.[0],
  ).toMatchObject({ confirm: requestConfirm, actionLabel: "生成图像" });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByRole("dialog", { name: "Existing request" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel existing" }));
  await expect(first).resolves.toBe(false);
  expect(screen.getByRole("dialog", { name: "生成图像" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Allow image" }));
  await act(async () => {
    await generated;
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});
