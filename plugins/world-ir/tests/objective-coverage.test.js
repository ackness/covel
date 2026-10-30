import { describe, expect, it } from "vitest";
import makeSubmit from "../tools/submit-world-facts.js";

const tool = makeSubmit({ tool: (definition) => definition });
const quest = "来自明天的呼叫";
const objectives = [
  "把这段来自未来的发射单独隔离备份一份",
  "拿信号和站里存档的你的声纹比对",
  "追查回声的时间和位置特征",
];
const source =
  "你将原始呼叫复制到独立介质，设为只读。副本完整播放，校验与原件一致。声纹比对支持录音者是你，但不能确认来源。";
const context = {
  inputSlots: {
    narrative: {
      cardinality: "one",
      value: [{ kind: "narration", text: source }],
    },
    vocabulary: {
      cardinality: "all",
      items: [
        {
          value: {
            entries: [{ type: "quest", name: quest, details: objectives }],
          },
        },
      ],
    },
  },
};
const empty = {
  schemaVersion: 1,
  entities: [],
  relations: [],
  events: [],
  statements: [],
};
const assessment = (objective, outcome = "not_addressed", evidence = "") => ({
  quest,
  objective,
  outcome,
  evidence,
});
const reviews = () => objectives.map((objective) => assessment(objective));
const event = (name, done, status = "progressed") => ({
  id: "quest-progress",
  type: "quest_change",
  attributes: { quest: name, status, completedObjectives: done },
});
const submit = (args, ctx = context) =>
  tool.execute(tool.parameters.parse(args), ctx);

describe("objective coverage before extraction succeeds", () => {
  it("checks evidence within individual source segments without using attribution or retry input", async () => {
    const ctx = structuredClone(context);
    ctx.inputSlots.narrative.value = [
      { kind: "dialogue", speaker: "Mira", text: "I will copy it." },
      { kind: "action", speaker: "Alex", text: source },
    ];
    ctx.inputSlots.turn = {
      cardinality: "one",
      value: { playerMessage: "I finished everything." },
    };
    for (const [outcome, evidence] of [
      ["planned", "I will copy it."],
      ["achieved", source],
    ]) {
      const events =
        outcome === "achieved" ? [event(quest, [objectives[0]])] : [];
      await expect(
        submit(
          {
            ...empty,
            events,
            objectiveAssessments: [
              assessment(objectives[0], outcome, evidence),
              ...reviews().slice(1),
            ],
          },
          ctx,
        ),
      ).resolves.toEqual({ ...empty, events });
    }
    for (const evidence of [
      "Mira",
      "Alex",
      "I finished everything.",
      `I will copy it.\n\n${source}`,
      JSON.stringify(ctx.inputSlots.narrative.value),
    ]) {
      await expect(
        submit(
          {
            ...empty,
            events: [event(quest, [objectives[0]])],
            objectiveAssessments: [
              assessment(objectives[0], "achieved", evidence),
              ...reviews().slice(1),
            ],
          },
          ctx,
        ),
      ).rejects.toThrow("exact current narrative");
    }
  });

  it("rejects the real omission shape: generic interactions with no objective review", async () => {
    await expect(
      submit({
        ...empty,
        events: [{ id: "backup", type: "interaction", description: source }],
      }),
    ).rejects.toThrow("missing assessment");
  });
  it("requires progress for achieved objectives and returns unchanged public WorldIR", async () => {
    const objectiveAssessments = reviews();
    objectiveAssessments[0] = assessment(
      objectives[0],
      "achieved",
      "你将原始呼叫复制到独立介质，设为只读。副本完整播放，校验与原件一致。",
    );
    objectiveAssessments[1] = assessment(
      objectives[1],
      "achieved",
      "声纹比对支持录音者是你，但不能确认来源。",
    );
    const args = { ...empty, objectiveAssessments };
    await expect(submit(args)).rejects.toThrow("needs a quest_change");
    await expect(submit(args)).rejects.toMatchObject({ code: "invalid-input" });
    const events = [event(quest, objectives.slice(0, 2))];
    await expect(submit({ ...args, events })).resolves.toEqual({
      ...empty,
      events,
    });
    await expect(
      submit({
        ...args,
        events: [event(quest, objectives.slice(0, 2), "completed")],
      }),
    ).rejects.toThrow("neither achieved nor superseded");
  });
  it.each(["planned", "partial", "failed", "unverified", "not_addressed"])(
    "does not allow %s judgments to finish an objective",
    async (outcome) => {
      const objectiveAssessments = reviews();
      objectiveAssessments[0] = assessment(
        objectives[0],
        outcome,
        outcome === "not_addressed" ? "" : source,
      );
      await expect(submit({ ...empty, objectiveAssessments })).resolves.toEqual(
        empty,
      );
      await expect(
        submit({
          ...empty,
          objectiveAssessments,
          events: [event(quest, [objectives[0]])],
        }),
      ).rejects.toThrow("needs an achieved assessment");
    },
  );
  it("rejects paraphrases, duplicate/missing reviews and invented or non-current evidence", async () => {
    const objectiveAssessments = reviews();
    await expect(
      submit({ ...empty, objectiveAssessments: objectiveAssessments.slice(1) }),
    ).rejects.toThrow("missing assessment");
    await expect(
      submit({
        ...empty,
        objectiveAssessments: [
          ...objectiveAssessments,
          objectiveAssessments[0],
        ],
      }),
    ).rejects.toThrow("duplicate");
    for (const evidence of [objectives[0], "It happened last turn.", ""]) {
      await expect(
        submit({
          ...empty,
          objectiveAssessments: [
            assessment(objectives[0], "achieved", evidence),
            ...objectiveAssessments.slice(1),
          ],
        }),
      ).rejects.toThrow("exact current narrative");
    }
    await expect(
      submit({
        ...empty,
        objectiveAssessments: [
          assessment("备份录音"),
          ...objectiveAssessments.slice(1),
        ],
      }),
    ).rejects.toThrow("verbatim");
  });
  it.each(["progressed", "completed", "accepted"])(
    "rejects %s with a shortened name that the consumer would resolve",
    async (status) => {
      await expect(
        submit({
          ...empty,
          objectiveAssessments: reviews(),
          events: [event("明天的呼叫", [objectives[0]], status)],
        }),
      ).rejects.toThrow("exact tracked name");
    },
  );
  it("keeps same-text objectives in different quests separate", async () => {
    const ctx = structuredClone(context);
    ctx.inputSlots.vocabulary.items[0].value.entries.push({
      type: "quest",
      name: "第二个任务",
      details: [objectives[0]],
    });
    await expect(
      submit({ ...empty, objectiveAssessments: reviews() }, ctx),
    ).rejects.toThrow("第二个任务");
  });
  it("does not treat bounded vocabulary as an exhaustive quest ledger", async () => {
    const events = [event("未列入上下文的委托", ["汇报检修结果"])];
    await expect(
      submit({ ...empty, objectiveAssessments: reviews(), events }),
    ).resolves.toEqual({ ...empty, events });
    const existing = [event(quest, ["汇报检修结果"])];
    await expect(
      submit({ ...empty, objectiveAssessments: reviews(), events: existing }),
    ).resolves.toEqual({ ...empty, events: existing });
  });
  it("rejects a shortened supplied objective instead of bypassing its assessment", async () => {
    await expect(
      submit({
        ...empty,
        objectiveAssessments: reviews(),
        events: [event(quest, ["单独隔离备份一份"])],
      }),
    ).rejects.toThrow("exact tracked objective");
  });
  it.each([
    [
      ["Compare the signal against your station voiceprint"],
      "Compare your station voiceprint with the signal",
    ],
    [["把这段来自未来的发射单独隔离备份一份"], "独立备份未来发射"],
    [["在风暴来临之前核算全站的用电预算"], "核算全站的用电预算"],
    [
      ["Inspect the north signal tower", "Inspect the south signal tower"],
      "Inspect the signal tower",
    ],
  ])(
    "rejects consumer-compatible or ambiguous aliases without completing anything",
    async (supplied, alias) => {
      const ctx = structuredClone(context);
      ctx.inputSlots.vocabulary.items[0].value.entries[0].details = supplied;
      await expect(
        submit(
          {
            ...empty,
            objectiveAssessments: supplied.map((text) => assessment(text)),
            events: [event(quest, [alias])],
          },
          ctx,
        ),
      ).rejects.toThrow("exact tracked objective");
    },
  );
  it("completes a quest whose remaining objective the story made unnecessary", async () => {
    const reached = "你没有等比对结果，直接确认了呼叫来自明天，任务就此了结。";
    const ctx = structuredClone(context);
    ctx.inputSlots.narrative.value = [
      { kind: "narration", text: source },
      { kind: "narration", text: reached },
    ];
    const objectiveAssessments = [
      assessment(objectives[0], "achieved", "你将原始呼叫复制到独立介质"),
      assessment(objectives[1], "achieved", "声纹比对支持录音者是你"),
      assessment(objectives[2], "superseded", reached),
    ];
    const done = event(quest, objectives.slice(0, 2), "completed");
    await expect(
      submit({ ...empty, events: [done], objectiveAssessments }, ctx),
    ).resolves.toEqual({ ...empty, events: [done] });
    // Without the completion, superseded cannot close an objective.
    const progressed = event(quest, objectives.slice(0, 2));
    await expect(
      submit({ ...empty, events: [progressed], objectiveAssessments }, ctx),
    ).rejects.toThrow(
      /superseded objective .* needs a quest_change with status completed/,
    );
    // It still needs a quote from the story, and never finishes the objective itself.
    await expect(
      submit(
        {
          ...empty,
          events: [done],
          objectiveAssessments: [
            ...objectiveAssessments.slice(0, 2),
            assessment(objectives[2], "superseded", ""),
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/2\.evidence/);
    await expect(
      submit(
        {
          ...empty,
          events: [event(quest, objectives, "completed")],
          objectiveAssessments,
        },
        ctx,
      ),
    ).rejects.toThrow(/needs an achieved assessment/);
  });
  it("keeps the retry guidance in the hint when the issue list is long", async () => {
    await expect(
      submit({ ...empty, objectiveAssessments: [] }),
    ).rejects.toMatchObject({
      code: "invalid-input",
      hint: expect.stringMatching(/Review every open objective/),
    });
  });
  it("allows no vocabulary and new accepted quests without inventing assessments", async () => {
    await expect(submit(empty, {})).resolves.toEqual(empty);
    const events = [event("独立的新委托", [], "accepted")];
    await expect(
      submit({ ...empty, objectiveAssessments: reviews(), events }),
    ).resolves.toEqual({ ...empty, events });
  });
});
