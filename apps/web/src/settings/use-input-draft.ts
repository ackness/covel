import { useRef, useState } from "react";

/** Keep partial input and newer edits intact while an earlier commit settles. */
export function useInputDraft(
  stored: string,
  commit: (value: string) => Promise<boolean> | void,
) {
  const [draft, setDraft] = useState<string | null>(null);
  const current = useRef<string | null>(null);
  const submitted = useRef<string | null>(null);
  return {
    value: draft ?? stored,
    set(value: string) {
      current.current = value;
      setDraft(value);
    },
    async flush() {
      const value = current.current;
      if (value === null || value === submitted.current) return;
      submitted.current = value;
      await commit(value);
      if (current.current === value) {
        current.current = null;
        setDraft(null);
      }
      if (submitted.current === value) submitted.current = null;
    },
  };
}
