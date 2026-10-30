/**
 * `contributes.actionKinds`: the action kinds a package lets players submit.
 * Loading and static validation share these rules, so `pnpm validate:plugin`
 * rejects what the loader would reject.
 */

import {
  composerFieldsOf,
  isBaseActionKind,
  pluginActionKindId,
  type ActionKindDescriptor,
  type PluginManifest,
} from "@covel/shared";

type ActionKindDeclarations = NonNullable<
  NonNullable<PluginManifest["contributes"]>["actionKinds"]
>;

/** Names that are not unique in the package or that take a base kind's name. */
export function actionKindDeclarationIssues(
  source: string | undefined,
  declarations: ActionKindDeclarations | undefined,
): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const [index, declaration] of (declarations ?? []).entries()) {
    const field = `contributes.actionKinds[${index}].name`;
    if (isBaseActionKind(declaration.name))
      issues.push(
        `${source}: ${field}: "${declaration.name}" is a base action kind; choose another name`,
      );
    if (seen.has(declaration.name))
      issues.push(
        `${source}: ${field}: action kind "${declaration.name}" is declared more than once`,
      );
    seen.add(declaration.name);
  }
  return issues;
}

/**
 * Warnings for the kinds whose fields schema the composer cannot show. Such a
 * kind still works (the server validates it, and an interaction can submit
 * it), but the composer leaves it out.
 */
export function composerFieldWarnings(
  source: string | undefined,
  declarations: ActionKindDeclarations | undefined,
  kinds: readonly ActionKindDescriptor[] | undefined,
): string[] {
  const warnings: string[] = [];
  for (const [index, declaration] of (declarations ?? []).entries()) {
    const schema = kinds?.[index]?.fieldsSchema;
    if (schema && composerFieldsOf(schema) === null)
      warnings.push(
        `${source}: ${actionKindSchemaField(index)}: fields schema of ${declaration.name} cannot be shown in the composer; the kind is not offered there (use only a flat object of string, number, integer and boolean properties)`,
      );
  }
  return warnings;
}

/** The field path of a declaration's schema, for messages. */
export function actionKindSchemaField(index: number): string {
  return `contributes.actionKinds[${index}].schema`;
}

/**
 * The catalogue entries of a package's action kinds, defaults resolved:
 * roles `[player]`, text `optional`, taken as a character. `schemas` holds
 * the parsed fields schema of each declaration that names one, by name.
 */
export function compileActionKinds(
  pluginId: string,
  declarations: ActionKindDeclarations | undefined,
  schemas: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): ActionKindDescriptor[] {
  return (declarations ?? []).map((declaration) => {
    const fieldsSchema = schemas[declaration.name];
    return {
      kind: pluginActionKindId(pluginId, declaration.name),
      source: "plugin" as const,
      pluginId,
      roles: declaration.roles ?? ["player"],
      text: declaration.text ?? "optional",
      actor: declaration.actor ?? true,
      display: {
        label: declaration.display.label,
        ...(declaration.display.icon ? { icon: declaration.display.icon } : {}),
        ...(declaration.display.placeholder !== undefined
          ? { placeholder: declaration.display.placeholder }
          : {}),
      },
      ...(fieldsSchema ? { fieldsSchema } : {}),
    };
  });
}

/** True when a parsed schema document is a JSON object. */
export function isSchemaObject(
  document: unknown,
): document is Readonly<Record<string, unknown>> {
  return (
    typeof document === "object" &&
    document !== null &&
    !Array.isArray(document)
  );
}
