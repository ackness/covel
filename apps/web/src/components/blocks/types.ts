import type { BlockEnvelope } from "../../types.js";

export interface HostBlockRendererProps {
  block: BlockEnvelope;
  onChoiceSelect?(optionId: string): void;
}
