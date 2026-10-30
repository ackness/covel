import { expect, test } from "@playwright/test";
import {
  composerInput,
  seedAppSettings,
  useServerWorlds,
} from "./helpers/player.js";

test.use({ viewport: { width: 1280, height: 900 } });

interface CapturedAction {
  requestId: string;
  type: string;
  sessionId: string;
  payload: { actions: { kind: string; text?: string }[] };
}

const AYA = { id: "e2e-aya", name: "阿雅", type: "player" };
const BO = { id: "e2e-bo", name: "阿波", type: "player" };

// A real session whose seat binds two player characters. Only the world's
// characters, the seat write and the action transport are stubbed: the
// action-kind catalogue comes from the server.
test("a second character acts in act mode and the bubble says who and how", async ({
  page,
}) => {
  await seedAppSettings(page);
  await useServerWorlds(page);
  const created = await page.request.post("/api/sessions", {
    data: { worldId: "mistport", locale: "zh-CN", plugins: ["narrator"] },
  });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };
  try {
    const [sessionResponse, viewResponse] = await Promise.all([
      page.request.get(`/api/sessions/${id}`),
      page.request.get(`/api/sessions/${id}/view`),
    ]);
    const record = await sessionResponse.json();
    const snapshot = await viewResponse.json();
    const seat = record.seats.find(
      (candidate: { role: string }) => candidate.role === "player",
    ) as { id: string };
    let seats = record.seats;
    const actions: CapturedAction[] = [];
    // The character the seat acted as when each action was sent.
    const actors: (string | undefined)[] = [];

    await page.route(`**/api/sessions/${id}`, (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: { ...record, seats, phase: "playing" } })
        : route.fallback(),
    );
    await page.route(
      `**/api/sessions/${id}/seats/${seat.id}`,
      async (route) => {
        const body = route.request().postDataJSON() as {
          currentCharacterId: string;
        };
        seats = seats.map((candidate: { id: string }) =>
          candidate.id === seat.id
            ? { ...candidate, currentCharacterId: body.currentCharacterId }
            : candidate,
        );
        await route.fulfill({ json: { seats } });
      },
    );
    await page.route(`**/api/sessions/${id}/view`, (route) =>
      route.fulfill({
        json: {
          ...snapshot,
          session: { ...snapshot.session, phase: "playing" },
          characters: [AYA, BO],
          messages: actions.map((action, index) => ({
            id: `e2e-player-${index}`,
            role: "user",
            turnId: `e2e-turn-${index}`,
            content: action.payload.actions[0]?.text ?? "",
            createdAt: "2026-01-01T00:00:00Z",
            actions: [
              {
                seatId: seat.id,
                kind: action.payload.actions[0]?.kind,
                text: action.payload.actions[0]?.text,
                actorId: actors[index],
                source: "player",
              },
            ],
          })),
        },
      }),
    );
    await page.route("**/api/actions", async (route) => {
      const action = route.request().postDataJSON() as CapturedAction;
      actions.push(action);
      const current = seats.find(
        (candidate: { id: string }) => candidate.id === seat.id,
      );
      actors.push(current?.currentCharacterId);
      await route.fulfill({ contentType: "text/event-stream", body: "" });
    });

    await page.goto(`/session?sid=${id}`);
    await expect(composerInput(page)).toBeEnabled();
    // The modes come from the session's action kinds.
    await expect(page.getByTestId("composer-mode-say")).toBeVisible();
    await expect(page.getByTestId("composer-mode-act")).toBeVisible();

    const switcher = page.getByTestId("composer-character-switcher");
    await expect(switcher).toBeVisible();
    await switcher.selectOption(BO.id);
    await expect(switcher).toHaveValue(BO.id);

    await page.getByTestId("composer-mode-act").click();
    await composerInput(page).fill("拔出剑");
    await composerInput(page).press("Enter");

    await expect.poll(() => actions.length).toBe(1);
    expect(actions[0]).toMatchObject({
      type: "submit_actions",
      sessionId: id,
      payload: { actions: [{ kind: "act", text: "拔出剑" }] },
    });
    // No actor is sent: the server takes the seat's current character.
    expect(actions[0]!.payload.actions[0]).not.toHaveProperty("actorId");

    const label = page.locator('[data-role="user"] .ui-message-role').first();
    await expect(label).toContainText(`${BO.name} · 行动`);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
    await page.request.delete(`/api/sessions/${id}`);
  }
});
