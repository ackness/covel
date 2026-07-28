/**
 * ConfirmHost — renders approval prompts published on the global confirm
 * channel as a themed dialog, replacing the blocking `window.confirm`.
 *
 * Requests queue rather than overwrite: two plugins asking for approval at
 * once would otherwise leave the first promise pending forever.
 */

import { useEffect, useState } from "react";
import {
  subscribeConfirm,
  type PendingConfirm,
} from "@/lib/confirm-channel.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";

export function ConfirmHost() {
  const [queue, setQueue] = useState<readonly PendingConfirm[]>([]);

  useEffect(
    () => subscribeConfirm((pending) => setQueue((prev) => [...prev, pending])),
    [],
  );

  const current = queue[0];

  const settle = (approved: boolean) => {
    if (!current) return;
    current.resolve(approved);
    setQueue((prev) => prev.slice(1));
  };

  return (
    <Dialog
      open={current !== undefined}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{current?.title}</DialogTitle>
          <DialogDescription className="whitespace-pre-line pt-1">
            {current?.message}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => settle(false)}>
            {current?.cancelLabel}
          </Button>
          <Button size="sm" onClick={() => settle(true)}>
            {current?.confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
