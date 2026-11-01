import { CircleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { projectStoryOperationFailures } from "@covel/shared";
import type { StreamMessage } from "@/stores/session-store.js";

/** Host safety notice; keep outside plugin theme parts and story templates. */
export function StoryOperationFailureNotice({
  message,
}: {
  readonly message: StreamMessage;
}) {
  const { t } = useTranslation();
  const { operationFailures } = projectStoryOperationFailures(message);
  if (!operationFailures || message.id.startsWith("stream_")) return null;
  return (
    <p
      className="flex items-start gap-2 text-sm text-muted-foreground"
      data-testid="story-operation-failure-notice"
      data-covel-host-controls=""
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>
        {t("session.operationFailedNotice", { count: operationFailures.count })}
      </span>
    </p>
  );
}
