/**
 * Behaviour tests for `<AssetTurnSidebar>`.
 *
 * Covers:
 *   - 0 assets for the turn → renders nothing (text-only turns stay clean)
 *   - 1 asset → renders one `<AssetRender>`
 *   - many assets → renders one `<AssetRender>` per asset, in order
 *   - missing SessionProvider → graceful no-op (catalog renderer safety)
 *
 * `useSession` and `<Media>` are stubbed so the component renders its routing
 * logic in isolation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { AssetGenerateView } from "@covel/shared";

// ── Mocks ──────────────────────────────────────────────────────────

interface FakeSessionState {
  session: { id: string } | null;
  assetsByTurn: Map<string, readonly AssetGenerateView[]>;
}

const fakeSessionState: { current: FakeSessionState | "throws" } = {
  current: {
    session: { id: "sess-1" },
    assetsByTurn: new Map(),
  },
};

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => {
    const cur = fakeSessionState.current;
    if (cur === "throws") {
      throw new Error("no SessionProvider");
    }
    return { state: cur };
  },
}));

vi.mock("@/components/Media.js", () => ({
  Media: ({
    src,
    sessionId,
    alt,
    as,
  }: {
    src: { id?: string; mime?: string };
    sessionId: string;
    alt?: string;
    as?: string;
  }) => (
    <div
      data-testid="media-stub"
      data-as={as}
      data-session-id={sessionId}
      data-alt={alt}
      data-mime={src?.mime ?? ""}
      data-id={src?.id ?? ""}
    />
  ),
}));
// AssetAudio now routes through AudioPlayer (theme-aware) rather than
// `<Media as="audio">`. Mirror the stub shape so existing assertions on
// `data-testid="media-stub"` keep working.
vi.mock("@/components/AudioPlayer.js", () => ({
  AudioPlayer: ({
    src,
    sessionId,
    alt,
  }: {
    src: { id?: string; mime?: string };
    sessionId: string;
    alt?: string;
  }) => (
    <div
      data-testid="media-stub"
      data-as="audio"
      data-session-id={sessionId}
      data-alt={alt}
      data-mime={src?.mime ?? ""}
      data-id={src?.id ?? ""}
    />
  ),
}));

import { AssetTurnSidebar } from "../AssetTurnSidebar.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeView(
  overrides: Partial<AssetGenerateView> = {},
): AssetGenerateView {
  return {
    id: `prop-${Math.random().toString(36).slice(2, 10)}`,
    type: "asset.generate",
    sessionId: "sess-1",
    turnId: "turn-1",
    source: { pluginId: "image", runtimeId: "image/runner" },
    ref: {
      id: "a".repeat(64),
      mime: "image/png",
      size: 16,
      url: "https://cdn.example/x.png",
    },
    modality: "image",
    createdAt: "2026-04-26T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  fakeSessionState.current = {
    session: { id: "sess-1" },
    assetsByTurn: new Map(),
  };
});

afterEach(() => {
  cleanup();
});

// ── Tests ──────────────────────────────────────────────────────────

describe("<AssetTurnSidebar>", () => {
  it("renders nothing when the turn has no assets", () => {
    const { container } = render(<AssetTurnSidebar turnId="turn-1" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one card when the turn has one asset", () => {
    fakeSessionState.current = {
      session: { id: "sess-1" },
      assetsByTurn: new Map([
        ["turn-1", [makeView({ id: "asset-1", modality: "image" })]],
      ]),
    };
    const { container } = render(<AssetTurnSidebar turnId="turn-1" />);
    expect(container.firstChild).not.toBeNull();
    const stubs = screen.getAllByTestId("media-stub");
    expect(stubs).toHaveLength(1);
    expect(stubs[0].getAttribute("data-as")).toBe("image");
  });

  it("renders one card per asset and preserves arrival order", () => {
    const a = makeView({
      id: "a-1",
      modality: "image",
      ref: { id: "1".repeat(64), mime: "image/png", size: 8 },
    });
    const b = makeView({
      id: "a-2",
      modality: "audio",
      ref: { id: "2".repeat(64), mime: "audio/wav", size: 16 },
    });
    const c = makeView({
      id: "a-3",
      modality: "tile",
      ref: { id: "3".repeat(64), mime: "application/octet-stream", size: 32 },
    });
    fakeSessionState.current = {
      session: { id: "sess-1" },
      assetsByTurn: new Map([["turn-1", [a, b, c]]]),
    };
    render(<AssetTurnSidebar turnId="turn-1" />);
    const stubs = screen.getAllByTestId("media-stub");
    expect(stubs).toHaveLength(3);
    // Image first, audio second, generic-link third — the generic-link path
    // mounts Media with as="auto", the others with as="image"/"audio".
    expect(stubs[0].getAttribute("data-as")).toBe("image");
    expect(stubs[1].getAttribute("data-as")).toBe("audio");
    expect(stubs[2].getAttribute("data-as")).toBe("auto");
  });

  it("isolates assets across turn ids", () => {
    fakeSessionState.current = {
      session: { id: "sess-1" },
      assetsByTurn: new Map([
        ["turn-A", [makeView({ id: "a", modality: "image" })]],
        [
          "turn-B",
          [
            makeView({
              id: "b1",
              modality: "audio",
              ref: { id: "0".repeat(64), mime: "audio/wav", size: 4 },
            }),
            makeView({
              id: "b2",
              modality: "audio",
              ref: { id: "f".repeat(64), mime: "audio/wav", size: 4 },
            }),
          ],
        ],
      ]),
    };
    render(<AssetTurnSidebar turnId="turn-B" />);
    const stubs = screen.getAllByTestId("media-stub");
    expect(stubs).toHaveLength(2);
    for (const s of stubs) {
      expect(s.getAttribute("data-as")).toBe("audio");
    }
  });

  it("returns null gracefully when no SessionProvider is mounted", () => {
    fakeSessionState.current = "throws";
    const { container } = render(<AssetTurnSidebar turnId="turn-1" />);
    expect(container.firstChild).toBeNull();
  });

  it("prefers an explicit sessionId prop over the active session", () => {
    fakeSessionState.current = {
      session: { id: "sess-1" },
      assetsByTurn: new Map([
        ["turn-1", [makeView({ id: "a", modality: "image" })]],
      ]),
    };
    render(<AssetTurnSidebar turnId="turn-1" sessionId="explicit-session" />);
    const stub = screen.getByTestId("media-stub");
    expect(stub.getAttribute("data-session-id")).toBe("explicit-session");
  });
});
