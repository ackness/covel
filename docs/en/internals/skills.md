# Agent skills in the repository

This page describes the four skills in the Covel repository's `.claude/skills/` folder: what each one does, how to let your coding assistant use it, and how to add a new one. It is written for people who work on Covel with a coding assistant such as Claude Code or Codex.

A skill is a set of operating instructions written for a coding assistant. The assistant reads it when it faces the matching task, and then follows it. It is plain documentation. The Covel backend does not read or run this folder, and the agents in the game do not use it either.

## The four current skills

| Skill                     | What it does                                                                                   | When it is used                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `create-plugin`           | Creates or changes a plugin: manifest, runtime, tools, UI panels. Validates it when done       | When you say you want a new plugin, a new game mechanic, or a new panel |
| `create-world`            | Generates a world package from your idea, writes it into `worlds/`, and validates it           | When you say you want a new world or a new setting                      |
| `covel-static-turn-audit` | Reads the code only, and works out whether scheduling of the runtimes in one turn can go wrong | Only when you explicitly ask for this audit                             |
| `covel-readonly-audit`    | Works by reading only. Checks the whole repository once, and writes the result as a report     | Only when you explicitly ask for this audit                             |

The last two are heavy tasks that read a lot of code. Their instructions say that they are "used only when the user explicitly asks". The assistant does not start them on its own.

### create-plugin

Entry: [`.claude/skills/create-plugin/SKILL.md`](../../../.claude/skills/create-plugin/SKILL.md)

It guides the assistant from a gameplay idea to a plugin that passes validation. The details of how to write fields, how to register tools, and how to test are in `references/` in the same folder. The assistant reads them only when it needs them.

The official community plugin repository has a separate version that suits developing plugins on their own: [`.agents/skills/create-plugin`](https://github.com/covel-ai/covel-plugins/tree/main/.agents/skills/create-plugin). Its examples and validation commands follow the directory structure of the community repository.

### create-world

Entry: [`.claude/skills/create-world/SKILL.md`](../../../.claude/skills/create-world/SKILL.md)

It has no field table and no plugin list of its own. It has the assistant run the command below first, so it can ask the current version what content can be written now:

```bash
pnpm describe:authoring
```

After writing, validate with this command:

```bash
pnpm validate:world worlds/<id>
```

Only two things are kept in `references/`: how to write dimensions, and what to check before publishing.

### covel-static-turn-audit

Entry: [`.claude/skills/covel-static-turn-audit/SKILL.md`](../../../.claude/skills/covel-static-turn-audit/SKILL.md)

It does not start the app, and it does not call a model. Its method is to treat each model call as a result that is unknown. It lists all the possible outcomes of one runtime execution, and then works inward layer by layer. First it reads the manifest of each plugin, then the relationships between plugins, then how the kernel schedules, and finally the commit and background jobs.

- Each finding is a counterexample that can be matched line by line in the code.
- For logic that cannot be judged by reading the code alone, it writes a small script and feeds it inputs to see the outputs. The scripts and logs are kept in `debugs/audits/`.
- The report is written to `devs/audits/`. Neither folder is committed to the repository.
- When you ask for it, it also produces an HTML block-diagram page (`assets/audit-map.html`) that uses boxes to show what each part of the code does and how the parts relate. The chart library loads from a CDN. If it cannot load, the same content is listed as text.

It does not carry its own copy of the turn flow. For what the framework promises, it reads [Turn flow](./flow.md). For which runtimes exist, it reads the current `PLUGIN.md` and `RUNTIME.md` files.

### covel-readonly-audit

Entry: [`.claude/skills/covel-readonly-audit/SKILL.md`](../../../.claude/skills/covel-readonly-audit/SKILL.md)

It runs nothing at all. It does not change project files, does not run programs, does not call Git, and does not call the models in the project.

1. By default, it gives only an audit plan. It reads the source code only after you clearly say "start".
2. It reads through the areas one by one first: frontend, backend, storage, model gateway, plugins, world packages, kernel, desktop app, media, suspend and resume with background tasks, and installation and trust boundaries.
3. Then it follows the key paths that cross several layers, and checks whether the layers connect correctly.
4. It records each area and each path as it reads, and finally puts them into one report at `devs/docs/audits/<date>-readonly-audit/README.md`. This folder is not committed to the repository.

The difference from the previous skill: this one covers the whole repository and runs nothing. The previous one looks only at runtime scheduling, and it can use small scripts to verify logic.

## Letting the assistant use the skills

**Claude Code.** When it starts, it scans skills in two places:

- `~/.claude/skills/<name>/SKILL.md`: your personal skills, available in every project.
- `<project>/.claude/skills/<name>/SKILL.md`: skills that come with the project. Covel's four skills are here.

Open Claude Code in the Covel repository, and say what you want to do (for example, "help me make a plugin that records rumors"). It picks the skill itself, based on the skill's instructions. If you want to avoid any ambiguity, name the skill: `/create-plugin`.

**Other assistants.** Any assistant that can read Markdown can use them. If it does not discover this folder on its own, ask it to read the whole `SKILL.md` of the target skill first:

```bash
cat .claude/skills/create-plugin/SKILL.md
```

Then it follows the guidance in that file, and reads the `references/` in the same folder when it needs to. Two points to note:

- Do not read only the first few hundred lines, and do not load all of `references/` into the assistant at once.
- The `agents/openai.yaml` in each skill folder only holds the name and short description shown in the interface and a default prompt. It is not an entry point for running anything.

## The folder of one skill

```text
.claude/skills/
├── create-plugin/
│   ├── SKILL.md              Entry point. The YAML at the top must have name and description
│   ├── agents/openai.yaml    Name, short description, and default prompt shown in the assistant's interface
│   └── references/           Details, read by the assistant only when needed
├── create-world/
│   ├── SKILL.md
│   ├── agents/openai.yaml
│   └── references/
├── covel-static-turn-audit/
│   ├── SKILL.md
│   ├── agents/openai.yaml
│   └── assets/audit-map.html Template for the diagram page. The assistant replaces only the data in it
└── covel-readonly-audit/
    ├── SKILL.md
    ├── agents/openai.yaml
    └── references/           What to audit, key paths, and how to write the report
```

The format follows the specification at [agentskills.io](https://agentskills.io).

## Adding a new skill

First decide whether it should be a skill at all:

| Good as a skill                                                          | Should be built into the framework or a plugin |
| ------------------------------------------------------------------------ | ---------------------------------------------- |
| A developer runs it now and then, to generate or change files            | A feature that players use in every turn       |
| Creating a world, creating a plugin, setting up a documentation skeleton | Game loop, tool calls, state management        |
| Templates for developers and authors                                     | Built-in tools for players and runtimes        |

In one sentence: a capability that fires in every turn is a plugin or a built-in tool. What a developer runs now and then is a skill. To build the first kind, see [Plugin authoring essentials](../plugins/essentials.md).

Once you have decided it is a skill:

1. Create `.claude/skills/<name>/SKILL.md`, and write it from the template below.
2. Put the details in `.claude/skills/<name>/references/`.
3. Create `agents/openai.yaml`, with at least `interface.display_name`, `short_description`, and `default_prompt`.
4. Check the YAML at the top of `SKILL.md`: it must have `name` and `description`, and `name` must match the folder name. The repository has no tool that checks this automatically.
5. Add the skill to the table and the folder diagram on this page, and update the Agent Skills section of the root `AGENTS.md`.
6. Open a pull request.

```markdown
---
name: my-skill
description: One sentence saying what this skill does and when to use it
---

# Skill title

## Input

What the user will provide: an idea, a few parameters, or context.

## Steps

1. First step
2. Second step
3. Third step

## Verification

Which command to run to confirm the result is correct.

## References

- For field details, read `references/xxx.md`
- For examples, read `references/example-xxx.md`
```

### Eight rules for writing a skill

1. **Keep the YAML at the top to standard fields only.** It must have at least `name` and `description`. Put information for the interface in `agents/openai.yaml`.
2. **Keep the entry point short.** Keep `SKILL.md` between 50 and 150 lines, so the assistant learns what the skill does and what its flow is with as few words as possible.
3. **Put details in `references/`.** The assistant reads it only when needed, so it can be detailed. Several hundred lines are fine there.
4. **The `description` decides whether the skill gets used.** The assistant relies on it to decide whether to use the skill. The more specific it is, the more accurate the choice.
5. **Write "when to use it" in the `description`.** The body is read only after the skill has been chosen, so writing it in the body means it has no effect. A heavy skill that should run only when the user explicitly asks must also say so in the `description`.
6. **Do not copy field tables.** Fields, allowed values, and component lists are authoritative in the pages of the [reference](../reference/index.md). The skill should only link to them. A copied table goes out of date without anyone noticing, and the assistant then writes errors by following it. A skill should record only its flow, the validation commands that work, and the pitfalls it has hit.
7. **Query the current version instead of hard-coding lists.** Anything that changes as plugins are added or removed (which data can be preset, which plugins exist, which settings exist) is printed by `pnpm describe:authoring`. If a skill contains a specific plugin ID, it creates one more place that someone must edit by hand for every new plugin.
8. **Examples must pass validation.** The full examples in a skill are validated in CI under the official rules (see `apps/server/tests/lib/authoring-describe.test.ts`). An example that fails cannot be merged.

## Related pages

- [Working with a coding assistant](../agent-workflow.md): the overall flow of developing in this repository with an assistant.
- [First plugin](../plugins/first-plugin.md) and [First world](../worlds/first-world.md): tutorials you do by hand, without an assistant.
- [agentskills.io](https://agentskills.io): the specification for the skill format.
