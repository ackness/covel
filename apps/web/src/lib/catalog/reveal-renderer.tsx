import type { ComponentRenderer } from "@json-render/react";
import { revealPropsSchema } from "@covel/shared";
import { Reveal as RevealGroup } from "@/lib/reveal/Reveal.js";
export const Reveal: ComponentRenderer = ({ element, children }) => {
  const result = revealPropsSchema.safeParse(element.props);
  return result.success ? (
    <RevealGroup {...result.data}>{children}</RevealGroup>
  ) : (
    <>{children}</>
  );
};
