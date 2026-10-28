import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import { PluginPanel } from "../plugin-panel.js";
import definitionSpec from "../../../../../../plugins/world-time/ui/definition-panel.json";
import {
  __clearAllPluginDataForTest,
  loadPluginDataForSession,
  setActiveSession,
} from "@/stores/plugin-data-store.js";

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: { gameState: { characters: [] }, session: { id: "before-story" } },
  }),
}));
vi.mock("react-force-graph-2d", () => ({ default: () => null }));
afterEach(async () => {
  cleanup();
  __clearAllPluginDataForTest();
  await i18n.changeLanguage("en-US");
});

function showDefinition(definition: Record<string, unknown>) {
  setActiveSession("before-story");
  loadPluginDataForSession("before-story", "world-time", "definitions", [
    { key: "world", value: { id: "world", definition } },
  ]);
  render(<PluginPanel pluginId="world-time" spec={definitionSpec} />);
}

it("summarizes authored phase rules before any clock has been committed", async () => {
  showDefinition({
    kind: "phases",
    name: "Tidal calendar",
    cycleLabel: "Tide cycle",
    phases: ["Rising tide", "High tide", "Falling tide"],
    initial: { cycle: 2, phase: 1 },
    evolution: {
      mode: "forward",
      defaultStep: 1,
      maxStep: 16,
      prompt: "Wait for the tide to travel.",
    },
  });
  expect(await screen.findByText("Tidal calendar")).toBeTruthy();
  // The author's prompt is shown once, not again inside a raw field dump.
  expect(screen.getAllByText("Wait for the tide to travel.")).toHaveLength(1);
  for (const phase of ["Rising tide", "High tide", "Falling tide"])
    expect(screen.getAllByText(phase).length).toBeGreaterThan(0);
  expect(screen.getAllByText("Tide cycle")).toHaveLength(2);
  expect(screen.getByText("2 ·")).toBeTruthy();
  // The starting phase is named once in the tag list and once at the start.
  expect(screen.getAllByText("High tide")).toHaveLength(2);
  expect(screen.getByText("Forward")).toBeTruthy();
  expect(screen.getByText("Default per turn, in phases")).toBeTruthy();
  expect(screen.getByText("16")).toBeTruthy();
  expect(screen.queryByText("Default per turn, in minutes")).toBeNull();
  expect(screen.queryByText("Months in a year")).toBeNull();
  expect(screen.queryByText("Random range")).toBeNull();
  for (const key of ["kind", "initial", "defaultStep", "maxStep", "evolution"])
    expect(screen.queryByText(new RegExp(`^${key}\\b`))).toBeNull();
  expect(screen.queryByText("Time appears when the story starts.")).toBeNull();
});

it("summarizes authored calendar rules with the start and step limits", async () => {
  showDefinition({
    kind: "calendar",
    name: "Station time",
    calendar: {
      era: "Station Year",
      months: [{ name: "Duskmonth", days: 30 }],
      hoursPerDay: 24,
      minutesPerHour: 60,
    },
    initial: { year: 1, month: 1, day: 1, hour: 6, minute: 4 },
    evolution: {
      mode: "random",
      defaultStep: 10,
      maxStep: 240,
      randomRange: { min: -30, max: 90 },
    },
  });
  expect(await screen.findByText("Station time")).toBeTruthy();
  expect(screen.getAllByText("Station Year")).toHaveLength(2);
  expect(screen.getByText("Months in a year")).toBeTruthy();
  expect(screen.getByText("1 · 1/1 06:04")).toBeTruthy();
  expect(screen.getByText("Jumps at random")).toBeTruthy();
  expect(screen.getByText("Most per turn, in minutes")).toBeTruthy();
  expect(screen.getByText("240")).toBeTruthy();
  expect(screen.getByText("-30")).toBeTruthy();
  expect(screen.getByText("90")).toBeTruthy();
  expect(screen.queryByText("Days of the week")).toBeNull();
  expect(screen.queryByText("Phases")).toBeNull();
});

it("explains the default calendar when no definition was imported", () => {
  setActiveSession("before-story");
  render(<PluginPanel pluginId="world-time" spec={definitionSpec} />);
  expect(screen.getByText(/12.*30/)).toBeTruthy();
});

it.each([
  ["en-US", "Tidal cycle", "High tide", "Low tide", "Tides change"],
  ["zh-CN", "轮次", "涨潮", "退潮", "随潮水演进"],
])(
  "resolves portable phase labels in %s",
  async (locale, cycle, high, low, prompt) => {
    await i18n.changeLanguage(locale);
    showDefinition({
      kind: "phases",
      name: { en: "Tides", zh: "潮汐" },
      cycleLabel: { en: "Tidal cycle", zh: "轮次" },
      phases: [
        { en: "High tide", zh: "涨潮" },
        { en: "Low tide", zh: "退潮" },
      ],
      initial: { cycle: 2, phase: 0 },
      evolution: {
        mode: "forward",
        defaultStep: 1,
        maxStep: 10,
        prompt: { en: "Tides change", zh: "随潮水演进" },
      },
    });
    expect(screen.getAllByText(cycle)).toHaveLength(2);
    expect(screen.getByText("2 ·")).toBeTruthy();
    expect(screen.getAllByText(high)).toHaveLength(2);
    expect(screen.getByText(low)).toBeTruthy();
    expect(screen.getAllByText(prompt)).toHaveLength(1);
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  },
);

it.each([
  ["en-US", "Age", "Firstday", "Lastday"],
  ["zh-CN", "纪元", "始日", "终日"],
])(
  "resolves portable calendar labels in %s",
  async (locale, era, first, last) => {
    await i18n.changeLanguage(locale);
    showDefinition({
      kind: "calendar",
      name: { en: "Clock", zh: "时钟" },
      calendar: {
        era: { en: "Age", zh: "纪元" },
        months: [{ name: { en: "First", zh: "一月" }, days: 30 }],
        weekdays: [
          { en: "Firstday", zh: "始日" },
          { en: "Lastday", zh: "终日" },
        ],
        hoursPerDay: 24,
        minutesPerHour: 60,
      },
      initial: { year: 1, month: 1, day: 1, hour: 6, minute: 4, weekday: 0 },
      evolution: { mode: "forward", defaultStep: 1, maxStep: 10 },
    });
    expect(screen.getAllByText(era)).toHaveLength(2);
    expect(screen.getByText("1 · 1/1 06:04")).toBeTruthy();
    expect(screen.getByText(first)).toBeTruthy();
    expect(screen.getByText(last)).toBeTruthy();
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  },
);
