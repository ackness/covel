import type { PresentationDeclaration } from "@covel/plugin-handlers-utils";
import type { RuntimeRuleIssue } from "./runtime-rules.js";

/** Common semantic view of authored and compiled declarations. */
export interface PresentationRuleView {
  readonly presentation?: PresentationDeclaration & {
    readonly publicAssetNamespaces?: readonly string[];
  };
  readonly runtimeType?: string;
  readonly stage?: string;
  readonly visibility?: string;
  readonly outputContract?: string;
  readonly concealed?: boolean;
  readonly subagentOnly?: boolean;
  readonly guard?: string;
  readonly background?: boolean;
  readonly trigger?: { readonly type?: string };
  readonly detached?: { readonly settle?: boolean };
  readonly effects?: {
    readonly reads?: readonly string[];
    readonly writes?: readonly string[];
  };
  readonly needs?: readonly unknown[];
  readonly output?: { readonly recordAs?: string };
  readonly builtinTools?: readonly string[];
  readonly pluginTools?: readonly string[];
  readonly serviceImports?: readonly unknown[];
  readonly advertiseEvents?: boolean;
  readonly injectedInput?: boolean;
  readonly presentationInputs?: Readonly<
    Record<
      string,
      {
        readonly from: {
          readonly runtime?: string;
          readonly kernel?: string;
          readonly contract?: string;
          readonly capability?: string;
          readonly cardinality?: string;
        };
        readonly required?: boolean;
        readonly scope?: string;
        readonly select?: string;
        readonly accepts?: string;
        readonly recordAs?: string;
      }
    >
  >;
}

export function presentationNamespace(effect: string): string | undefined {
  const match = /^plugin-data:self:([a-zA-Z][a-zA-Z0-9_-]{0,63})$/.exec(effect);
  return match?.[1];
}

export function presentationRuleIssues(
  m: PresentationRuleView,
  authoring: boolean,
): RuntimeRuleIssue[] {
  if (!m.presentation) return [];
  const issues: RuntimeRuleIssue[] = [];
  const at = (authored: string, compiled: string) =>
    (authoring ? authored : compiled).split(".");
  const add = (authored: string, compiled: string, message: string) =>
    issues.push({
      path: at(authored, compiled),
      message: `presentation: ${message}`,
      disables: "runtime",
    });
  if (m.runtimeType !== "function")
    add(
      "presentation",
      "presentation",
      "only function runtimes are supported; add function or remove presentation",
    );
  if (m.stage !== "post-turn")
    add("schedule.stage", "stage", "requires post-turn");
  if ((m.visibility ?? "system") !== "system")
    add("io.visibility", "outputKind", "requires system visibility");
  if (m.outputContract === "narrative-engine@2")
    add(
      "io.output.contract",
      "outputContract",
      "cannot provide the story contract",
    );
  if ((m.trigger?.type ?? "auto") !== "auto")
    add("schedule.trigger", "trigger", "requires staged auto activation");
  if (m.subagentOnly)
    add("schedule.subagentOnly", "subagentOnly", "cannot run as a sub-agent");
  if (m.background)
    add(
      "schedule.background",
      "execution",
      "use staged detachment, not background activation",
    );
  if (m.guard) add("guard", "guard", "cannot have a guard");
  if (m.concealed)
    add("io.concealed", "concealed", "cannot use a concealed input channel");
  if (m.output?.recordAs)
    add(
      "io.output.recordAs",
      "output.recordAs",
      "cannot publish recorded exports",
    );
  if (m.needs?.length)
    add(
      "schedule.needs",
      "needs",
      "cannot require upstream runtimes; bind optional public story input",
    );
  if (m.injectedInput)
    add(
      "io",
      "input",
      "cannot read injected, committed or activation payloads",
    );
  if (
    m.builtinTools?.length ||
    m.pluginTools?.length ||
    m.serviceImports?.length
  )
    add(
      "function.tools",
      "tools",
      "tools, services and delegation are unavailable",
    );
  if (m.advertiseEvents)
    add(
      "agent.advertiseEvents",
      "advertiseEvents",
      "cannot advertise or emit events",
    );
  if (m.detached?.settle)
    add(
      "schedule.detached.settle",
      "turnCompletion.settle",
      "cannot hold the next execution's barrier",
    );
  const budget = m.presentation.budget;
  if (
    ((budget?.calls ?? 0) > 0 || (budget?.generations ?? 0) > 0) &&
    !m.detached
  )
    add(
      "schedule.detached",
      "turnCompletion",
      "a positive budget requires detached execution",
    );
  for (const [name, binding] of Object.entries(m.presentationInputs ?? {})) {
    if (
      (binding.from.contract ?? binding.from.capability) !==
        "narrative-engine@2" ||
      (binding.from.cardinality ?? "one") !== "one" ||
      binding.required !== false ||
      (binding.scope ?? "turn") !== "turn" ||
      binding.select !== undefined ||
      binding.accepts !== undefined ||
      binding.recordAs !== undefined
    )
      issues.push({
        path: [...at("io.inputs", "inputs"), name],
        message:
          "presentation: bind only optional, untransformed turn-scoped narrative-engine@2",
        disables: "runtime",
      });
  }
  if (!m.effects)
    add("effects", "effects", "declare explicit own display reads and writes");
  const writes = new Set<string>();
  for (const [index, effect] of (m.effects?.writes ?? []).entries()) {
    const namespace = presentationNamespace(effect);
    if (namespace) writes.add(namespace);
    else if (effect !== "assets:*" && effect !== "media:*")
      issues.push({
        path: ["effects", "writes", index],
        message:
          "presentation: only explicit own public namespaces and scoped media helpers may be written",
        disables: "runtime",
      });
  }
  for (const [index, effect] of (m.effects?.reads ?? []).entries()) {
    const namespace = presentationNamespace(effect);
    const assets =
      m.presentation.publicAssetNamespaces ?? (authoring ? undefined : []);
    if (effect === "assets:*" || effect === "media:*") continue;
    if (
      !namespace ||
      (assets !== undefined &&
        !writes.has(namespace) &&
        !assets.includes(namespace))
    )
      issues.push({
        path: ["effects", "reads", index],
        message:
          "presentation: read only declared public assets or an explicit own display-write namespace",
        disables: "runtime",
      });
  }
  return issues;
}
