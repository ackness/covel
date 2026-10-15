import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePrepWorldRestore } from "../use-prep-world-restore.js";

const worlds = [{ id: "mistport" }, { id: "emberback" }];

afterEach(() => sessionStorage.clear());

describe("usePrepWorldRestore", () => {
  it("remembers the world on the prep screen and selects it again after a reload", () => {
    const first = renderHook(
      (props: { prepWorldId?: string }) =>
        usePrepWorldRestore({
          booted: true,
          sid: undefined,
          worlds,
          prepWorldId: props.prepWorldId,
          inSession: false,
          selectWorld: vi.fn(),
        }),
      { initialProps: {} },
    );
    first.rerender({ prepWorldId: "emberback" });
    first.unmount();

    const selectWorld = vi.fn();
    renderHook(() =>
      usePrepWorldRestore({
        booted: true,
        sid: undefined,
        worlds,
        prepWorldId: undefined,
        inSession: false,
        selectWorld,
        reloaded: true,
      }),
    );
    expect(selectWorld).toHaveBeenCalledWith("emberback");
  });

  it("starts on the world list when the app is opened anew", () => {
    sessionStorage.setItem("covel:prep-world", "mistport");
    const selectWorld = vi.fn();
    renderHook(() =>
      usePrepWorldRestore({
        booted: true,
        sid: undefined,
        worlds,
        prepWorldId: undefined,
        inSession: false,
        selectWorld,
        reloaded: false,
      }),
    );
    expect(selectWorld).not.toHaveBeenCalled();
  });

  it("leaves a session in the URL alone and forgets a world once the game starts", () => {
    sessionStorage.setItem("covel:prep-world", "mistport");
    const selectWorld = vi.fn();
    renderHook(() =>
      usePrepWorldRestore({
        booted: true,
        sid: "session-1",
        worlds,
        prepWorldId: "mistport",
        inSession: true,
        selectWorld,
        reloaded: true,
      }),
    );
    expect(selectWorld).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("covel:prep-world")).toBeNull();
  });
});
