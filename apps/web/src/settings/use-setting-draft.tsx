import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button.js";

/** Keep an unfinished edit visible when another window changes its base. */
export function useSettingDraft(value: string, identity = "") {
  const [state, setState] = useState({ value, draft: value, identity });
  const dirty = state.draft !== state.value;
  const conflict = dirty && state.value !== value && state.draft !== value;
  useEffect(() => {
    if (state.identity !== identity || !dirty || state.draft === value) {
      setState((previous) =>
        previous.value === value && previous.identity === identity
          ? previous
          : { value, draft: value, identity },
      );
    }
  }, [value, identity, dirty, state.draft, state.identity]);
  return {
    draft: state.draft,
    conflict,
    setDraft: (draft: string) =>
      setState((previous) => ({ ...previous, draft })),
    reset: () => setState({ value, draft: value, identity }),
  };
}

export function SettingsDraftConflict({ onReload }: { onReload: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="space-y-2 text-xs text-destructive">
      <p>
        {t("settings.draftConflict", {
          defaultValue:
            "This setting changed in another window. Your draft has been kept. Reload the saved value before editing again.",
        })}
      </p>
      <Button type="button" variant="outline" size="sm" onClick={onReload}>
        {t("settings.reloadSavedValue", { defaultValue: "Reload saved value" })}
      </Button>
    </div>
  );
}
