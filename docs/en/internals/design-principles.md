# Design Principles

This page first sets out Covel's product principles, then answers the question "why is Covel designed this way?": what belongs in the kernel, and what is left to plugins. Anyone who wants to add a feature to the framework, or who is not sure where a piece of logic should go, should read this page first.

For other questions, go to other pages:

- How the parts connect: [flow.md](./flow.md)
- Field contracts: [Reference](../reference/index.md)
- How to write a plugin: [Plugin Essentials](../plugins/essentials.md)
- Term definitions: [Glossary](../reference/glossary.md)

## Product principles

These are the grounds for every trade-off. Where the code disagrees with them, the code is what changes.

### Players come first

- Covel is for players and for developers. What matters most is that a player can easily play a world someone else built, or one they made themselves.
- Developers, experienced players, or agents working for them extend the gameplay and the settings.
- What the framework provides is the scheduling between agents and the player: when the player says something, the framework decides which plugins respond, in what order, and with what context. On top of that, it serves world packages and plugins at every layer: loading, scheduling, storage and the interface.

### Every plugin is equal

- Every framework capability serves every plugin, not just the bundled ones.
- Bundled plugins are examples shipped with the app to show what the framework can do. They use the same interfaces as community plugins, and nothing a community plugin cannot use. The only difference is trust: bundled plugins ship with the app and run without the player's approval.
- Framework code makes no special case for any particular plugin; see "The core: the kernel provides primitives, plugins carry gameplay" below. With every plugin removed, the framework must still run.
- One narrative plugin must be enough to play a world from start to finish. Every other plugin is there to enrich play.
- The four bundled worlds are demos too. Mistport, Harukaze Academy and Lantern Barrow each show one play style: traditional narrative, stage mode and tabletop rules. Emberback is written in English for English-speaking players, and shows how a world carries several languages.

### Missing pieces must not stop the game

- If a field a plugin needs is missing, the plugin ignores it. If a world package has fields that nothing uses, the game still runs.
- A missing plugin or missing data only removes the matching feature. It must not block the start of a game or stop the story.
- Problems are reported, not hidden: the validation tools tell the author, and the interface tells the player what is missing.

### Several deployments, one core

| Deployment          | Who runs it                   | Where player data lives                                                                                  | Now                      |
| ------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------ |
| Desktop app         | The player, on their computer | A local SQLite file; PostgreSQL also works (for now only through environment variables)                  | The focus                |
| Self-hosted web app | The player or a team          | A SQLite file on the server, or their own PostgreSQL                                                     | The focus                |
| Official web app    | The Covel project             | In the player's own browser (IndexedDB). The server only handles requests and must not store player data | Not supported yet; later |

- The desktop app and the self-hosted web app come first: their details are being polished now. The official web app is not supported yet and comes later.
- The core stays generic: storage, authentication and model access get no special case for one deployment, and the differences between deployments should live in one place in the configuration. Adding the official web app later then means adding one more configuration, not rewriting the core.
- SQLite is enough for ordinary players, and the choice of database makes almost no difference to them. PostgreSQL must keep working, but it is for professional developers and users with special needs. Any difference in behaviour between the two backends is a bug, and the shared contract suite catches it.
- How each deployment stores data is in [Storage](./storage.md).
- A commercial edition is not being built, and this repository is not updated for one. If one is built later, it builds on the same core.

### Writing should be simple

- A plugin can use functions only, agents only, or both; see "Two primitives plus composition" below. Agents call tools to do complex work, and functions handle what must be exact.
- A plugin describes its interface with one shared declaration format (json-render today), and the framework renders it. The framework writes no special interface for any plugin.
- A plugin or a world package should need as few fields as possible. Anything that can be derived, or has a sensible default, should not be required. Before adding a field, check whether the existing contracts, extension points and data namespaces can already express it.

### Development is fast for now

This is not a stable release yet. Contracts and definitions can change directly, with no compatibility branches for old data or old fields; see "Current contract only" in [AGENTS.md](../../../AGENTS.md). When a contract changes, the release notes say which data has to be recreated.

## Basic goal

Any creator should be able to write a game idea as a declaration that follows the spec, and the framework can then orchestrate it into a playable scene. The creator may or may not know how to write code, and may even be an AI agent.

**The spec constrains "how to plug into the framework", not "what can be played".**

A cyberpunk infiltration, a courtroom debate, or a confession in a visual novel are all the same thing to the framework: a set of plugins declared against contracts, plus a [World](../reference/glossary.md), orchestrated turn by turn by the [Kernel](../reference/glossary.md).

## The core: the kernel provides primitives, plugins carry gameplay

Everything in Covel starts from this one rule. The [AGENTS.md](../../../AGENTS.md) file at the root of the repository makes it a mandatory rule, named the "Framework ↔ Plugin Isolation Rule".

- **Kernel** (`packages/`, `apps/server/src/`, `apps/web/src/`) provides only five basic building blocks, and orchestration. It does not recognize any specific gameplay.
- **Plugins** carry the gameplay logic. A plugin declares four things: **when it triggers, what Context it sees, which kind of Runtime runs it, and what Proposal it produces.**

The five basic building blocks (primitives) are:

| Primitive | In one sentence                                                                |
| --------- | ------------------------------------------------------------------------------ |
| Runtime   | A runnable piece inside a plugin: a prompt or a function                       |
| Tool      | A fixed operation that a model or a function can call                          |
| Hook      | A handler that plugs in at a fixed moment to check, rewrite, or record         |
| Context   | What a Runtime can see while it runs                                           |
| Proposal  | A request that says "please save this", which the kernel checks before writing |

Orchestration means three things: scheduling, assembling context, and validating and committing.

An intuitive analogy: a plugin grows a standard "plug", which is the four declarations above, and the Kernel can supply power to it, meaning orchestration, composition, and reuse. The Kernel does not touch whatever "appliance" is plugged in behind it. The appliance is your logic, narrative, judgment rules, and worldview.

### One ruling rule

To decide whether something should go into the Kernel, ask one question: **is it a "plug" (an interface or contract), or an "appliance" (content or logic)?**

| What it is | Example                                                                      | Who owns it                                                                                |
| ---------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Plug       | "How a plugin declares its trigger conditions", "which Proposal types exist" | The Kernel owns it. It needs a spec, written up in the [Reference](../reference/index.md). |
| Appliance  | "Should this NPC trust the player?"                                          | The Kernel does not touch it. It is left to the plugin.                                    |

One consequence follows, and AGENTS.md already enforces it: **framework code never hardcodes a specific plugin ID, and never changes the kernel for a single gameplay feature.**

When a legitimate scenario cannot be expressed, the right move is to add one **generic** pin to the Kernel: a new Proposal type, a new Hook event, or a new trigger mode. Do not hardcode a piece of logic. This way any plugin can be replaced, and the framework does not need to change.

## Two primitives plus composition = the creator's "three ways of writing"

There are only two kinds of [Runtime](../reference/glossary.md):

| Kind             | How you write it                                                                                                                     | What it suits                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| agent runtime    | Write the rules in natural language in `PLUGIN.md`. The model reads the rules and the context, and it judges and narrates by itself. | Gameplay that needs understanding, discretion, or generated text. In other words, having the model act as the judge. |
| function runtime | A JS handler that reads the context, computes, and produces output in a fixed way.                                                   | Things that must be precise, fair, reproducible, and free. For example, dice rolls cannot be left to a model.        |

Creators often call these "modes", and they also talk about a third one, "hybrid". But Covel has **no "hybrid" primitive**. What is called a hybrid is a **composition** of two kinds of Runtime, and it relies on two kinds of glue:

- **Tool**: an agent calls a tool implemented by a function, which reliably triggers fixed logic.
- **io.inputs**: sends the output of one runtime into the Context of another runtime.

This way the Kernel needs only two building blocks, yet creators can express any gameplay that combines "fixed rules with narrative". For a dice example and how it is written, see [Plugins with local code](../plugins/local-code.md).

> [!NOTE]
> "Writing style / mode" here means the **execution method**. The **Trigger mode** in the glossary is something else. It describes when a runtime runs: `auto` / `manual` / `event`. Do not mix the two up.

## The boundary of what can be expressed

A scenario is supported by the framework as long as it can be broken down into the four steps below. It can be any turn-based scene driven by narrative or by an agent:

**When it triggers → what Context it sees → which Runtime decides → what Proposal it produces**

Things that cannot fit this pattern are not Covel's goal. Examples are real-time action and pixel-level physics. For the full turn pipeline, see [flow.md](./flow.md).

## Failure isolation (why everything goes through Proposals)

Plugins never write to the database directly. They always produce a [Proposal](../reference/glossary.md), and the Kernel checks it and commits it. This is the only write channel between the Kernel and a plugin.

This boundary brings three things:

- **If one plugin fails, only its own output is lost.** When a plugin crashes or its commit is rejected, the narrative that has already been generated is not dragged down with it. Each optional plugin commits inside its own savepoint (a small section of a transaction that can be rolled back on its own). A downstream plugin that hard-depends on it is discarded along with it, and its state is recorded as failed.
- **Several plugins that change the same thing do not fight each other.**
- **A plugin can see only its own data.**

An execution with no narrative still either succeeds as a whole or rolls back as a whole. These executions include manual triggers, background runs, and opening setup.

"Flexible but not out of control" comes from this.

## Further reading

- How to write a plugin: [Plugin Essentials](../plugins/essentials.md)
- The end-to-end execution pipeline and state model: [flow.md](./flow.md)
- The authoritative definitions of terms: [Glossary](../reference/glossary.md)
- The full isolation rule: the "Framework ↔ Plugin Isolation Rule" in [AGENTS.md](../../../AGENTS.md)
