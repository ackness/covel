import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { PortraitGalleryPanel } from "../portrait-gallery-panel.js";

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  rpc: vi.fn(),
  approval: vi.fn(),
  confirm: vi.fn(),
  run: vi.fn(),
  toast: vi.fn(),
  order: [] as string[],
}));
vi.mock("@/services/api.js", () => ({
  uploadSessionMedia: mocks.upload,
  postPluginRpc: mocks.rpc,
  resolveApproval: mocks.approval,
}));
vi.mock("@/services/data-service.js", () => ({
  getSessionWorkspace: () => ({ run: mocks.run }),
}));
vi.mock("@/lib/confirm-channel.js", () => ({ requestConfirm: mocks.confirm }));
vi.mock("@/lib/toast-channel.js", () => ({ emitToast: mocks.toast }));
vi.mock("@/lib/catalog/session-context.js", () => ({
  useActiveSessionId: () => "session-a",
}));
vi.mock("@/stores/plugin-data-store.js", () => ({
  usePluginNamespace: () => ({
    hero: { schemaVersion: 1, characterId: "hero", displayName: "Hero" },
    guide: { schemaVersion: 1, characterId: "guide", displayName: "Guide" },
  }),
}));
vi.mock("@/components/Media.js", () => ({ Media: () => null }));
vi.mock("@/components/MediaPreviewDialog.js", () => ({
  MediaPreviewDialog: () => null,
}));
const ref = { id: "a".repeat(64), mime: "image/png", size: 3 };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.order = [];
  mocks.run.mockImplementation(
    async (
      _session: string,
      _action: string,
      mutate: () => Promise<unknown>,
    ) => {
      mocks.order.push("hydrate");
      const result = await mutate();
      mocks.order.push("checkpoint");
      return result;
    },
  );
  mocks.upload.mockImplementation(async () => {
    mocks.order.push("upload");
    return ref;
  });
  mocks.rpc.mockImplementation(async () => {
    mocks.order.push("rpc");
    return { status: "ok" };
  });
  mocks.confirm.mockResolvedValue(true);
  mocks.approval.mockImplementation(async () => {
    mocks.order.push("approve");
  });
});
function upload() {
  const view = render(
    <PortraitGalleryPanel
      pluginId="portrait-provider"
      runtimeId="portrait-provider/save"
    />,
  );
  const input = view.container.querySelector("input[type=file]")!;
  fireEvent.change(input, {
    target: {
      files: [new File(["png"], "portrait.png", { type: "image/png" })],
    },
  });
  return { view, input };
}
it("hydrates before upload and resolves approval without uploading twice", async () => {
  mocks.rpc.mockImplementationOnce(async () => {
    mocks.order.push("rpc");
    return { status: "approval-required", approvalId: "approve-a" };
  });
  upload();
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
  expect(mocks.order).toEqual([
    "hydrate",
    "upload",
    "rpc",
    "checkpoint",
    "approve",
    "hydrate",
    "rpc",
    "checkpoint",
  ]);
  expect(mocks.upload).toHaveBeenCalledOnce();
  expect(mocks.approval).toHaveBeenCalledWith(
    "approve-a",
    "allow",
    "session",
    "session-a",
  );
  expect(mocks.rpc).toHaveBeenLastCalledWith(
    "session-a",
    expect.objectContaining({
      pluginId: "portrait-provider",
      runtimeId: "portrait-provider/save",
      payload: {
        presence: expect.objectContaining({
          characterId: "hero",
          avatar: ref,
          sprite: ref,
        }),
      },
    }),
  );
});
it("reports failed runtime results instead of silently completing the replacement", async () => {
  mocks.rpc.mockResolvedValueOnce({
    status: "ok",
    runtimeResults: [{ runtimeId: "save", status: "failed" }],
  });
  upload();
  await waitFor(() =>
    expect(mocks.toast).toHaveBeenCalledWith("error", "Runtime save failed"),
  );
});
it("stops after a denied approval", async () => {
  mocks.rpc.mockResolvedValueOnce({
    status: "approval-required",
    approvalId: "deny-a",
  });
  mocks.confirm.mockResolvedValueOnce(false);
  upload();
  await waitFor(() =>
    expect(mocks.approval).toHaveBeenCalledWith(
      "deny-a",
      "deny",
      "session",
      "session-a",
    ),
  );
  expect(mocks.rpc).toHaveBeenCalledOnce();
});
it("does not upload into a workspace whose hydration failed", async () => {
  mocks.run.mockRejectedValueOnce(new Error("restore failed"));
  upload();
  await waitFor(() =>
    expect(mocks.toast).toHaveBeenCalledWith("error", "restore failed"),
  );
  expect(mocks.upload).not.toHaveBeenCalled();
});
it("prevents a second replacement while the current upload is pending", async () => {
  let release!: (value: typeof ref) => void;
  mocks.upload.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const { view, input } = upload();
  fireEvent.change(input, {
    target: { files: [new File(["other"], "other.png")] },
  });
  expect(
    [...view.container.querySelectorAll<HTMLInputElement>("input")].every(
      (item) => item.disabled,
    ),
  ).toBe(true);
  expect(mocks.upload).toHaveBeenCalledOnce();
  release(ref);
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledOnce());
  expect(screen.getByText("Hero")).toBeTruthy();
});
