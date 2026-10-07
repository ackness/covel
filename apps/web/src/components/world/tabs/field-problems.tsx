import type { ReactNode } from "react";
import type { FieldProblems } from "../editor-helpers.js";

/** One problem, under its field. It takes a whole row inside a field grid. */
export function ProblemText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="col-span-full text-xs text-destructive">
      {children}
    </p>
  );
}

/**
 * Places the problems that stopped a save in one tab. `at` gives the problem
 * of the field at a path, to render under that field; `label` names the field
 * where one line serves a row of them. `rest` gives the problems no field
 * took, each with its path, so a tab calls it after all its fields: a problem
 * is then never without a place on screen.
 */
export function fieldProblems(problems: FieldProblems | undefined) {
  const placed = new Set<string>();
  return {
    at(path: string, label?: string): ReactNode {
      const message = problems?.[path];
      if (!message) return null;
      placed.add(path);
      return (
        <ProblemText>{label ? `${label}: ${message}` : message}</ProblemText>
      );
    },
    rest(): ReactNode {
      const left = Object.entries(problems ?? {}).filter(
        ([path]) => !placed.has(path),
      );
      if (left.length === 0) return null;
      return (
        <ul role="alert" className="space-y-1 text-xs text-destructive">
          {left.map(([path, message]) => (
            <li key={path}>{path ? `${path}: ${message}` : message}</li>
          ))}
        </ul>
      );
    },
  };
}
