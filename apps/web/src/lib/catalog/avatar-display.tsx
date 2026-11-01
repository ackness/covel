import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MediaRef } from "@covel/shared";
import { Media } from "@/components/Media.js";
import { MediaPreviewDialog } from "@/components/MediaPreviewDialog.js";

/** Public portrait presentation; callers own resolution and scope the React key. */
export function AvatarDisplay({
  avatar,
  sessionId,
  size = 28,
}: {
  readonly avatar: MediaRef;
  readonly sessionId: string;
  readonly size?: number;
}) {
  const [zoomed, setZoomed] = useState(false);
  const { t } = useTranslation();
  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setZoomed(true);
        }}
        className="inline-block shrink-0 overflow-hidden rounded-md border border-border cursor-zoom-in"
        style={{ width: size, height: size }}
        aria-label={t("characterPresence.enlarge")}
      >
        <Media
          src={avatar}
          sessionId={sessionId}
          alt=""
          aspectRatio="1/1"
          rounded="md"
          fit="cover"
        />
      </button>
      <MediaPreviewDialog
        mediaRef={zoomed ? avatar : null}
        sessionId={sessionId}
        aspectRatio="3/4"
        onClose={() => setZoomed(false)}
      />
    </>
  );
}
