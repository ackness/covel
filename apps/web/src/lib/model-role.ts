import {
  defaultModelRoleTag,
  getBuiltinProviderConnection,
  modelOutputTag,
  protocolOutputModalities,
  supportsModelRole,
} from "@covel/shared";

export interface RoleModel {
  provider: string;
  protocol?: string;
  capability?: { output: readonly string[] };
}

export function modelOutputs(model: RoleModel): readonly string[] {
  const protocolOutput = protocolOutputModalities(
    model.protocol ?? getBuiltinProviderConnection(model.provider)?.protocol,
  );
  return protocolOutput.includes("evaluation")
    ? protocolOutput
    : (model.capability?.output ?? protocolOutput);
}

export function modelRoleTag(
  slotId: string,
  configuredTag?: string,
  model?: RoleModel,
): string {
  return (
    configuredTag ??
    defaultModelRoleTag(slotId) ??
    (model ? modelOutputTag(modelOutputs(model)) : "text")
  );
}

export function isRoleModelCompatible(model: RoleModel, tag: string): boolean {
  return supportsModelRole(modelOutputs(model), tag);
}
