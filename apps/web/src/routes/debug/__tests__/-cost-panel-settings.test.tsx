import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { getSettings, initSettings } from "@/settings/store.js";
import type { VisibleTurn } from "../-debug-page-model.js";

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: {
      presets: [],
      llmConfig: {
        slots: { story: { provider: "cost-fixture", model: "cost-model" } },
      },
    },
  }),
}));
vi.mock("@/services/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api.js")>()),
  lookupModelCapability: vi.fn(async () => ({
    inputPerMToken: 2,
    outputPerMToken: 4,
  })),
}));

const { CostPanel } = await import("../-cost-panel.js");

it("reacts to local prices and provider multipliers without pricing a changed target's history", async () => {
  await initSettings();
  const store = getSettings();
  await store.setMany({
    "llm.capabilityOverrides": { story: { pricing: { inputPerMToken: 1 } } },
    "llm.providerPriceMultipliers": { "cost-fixture": 0.5 },
  });
  const turns = [
    {
      turnIndex: 1,
      turn: {
        turnId: "turn",
        events: [
          {
            type: "gateway.responded",
            payload: {
              provider: "cost-fixture",
              model: "cost-model",
              usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
            },
          },
        ],
      },
    },
  ] as unknown as VisibleTurn[];
  render(<CostPanel turns={turns} />);
  await screen.findByText(/^≈ \$1\.5000$/);

  await act(() =>
    store.set("llm.capabilityOverrides", {
      story: { pricing: { inputPerMToken: 0 } },
    }),
  );
  expect(screen.getByText(/^≈ \$1\.0000$/)).toBeTruthy();
  await act(() =>
    store.set("llm.providerPriceMultipliers", { "cost-fixture": 2 }),
  );
  expect(screen.getByText(/^≈ \$4\.0000$/)).toBeTruthy();
  await act(() =>
    store.setMany({
      "llm.providers": [
        {
          id: "cost-fixture",
          name: "Fixture",
          baseUrl: "https://fixture.invalid",
          models: [{ ref: "changed", modelId: "different-model" }],
        },
      ],
      "llm.slotConfig": { story: { modelRef: "changed" } },
    }),
  );
  expect(screen.getByText(/^≈ \$8\.0000$/)).toBeTruthy();
});
