/**
 * ConfirmHost — renders approval prompts published on the global confirm
 * channel as a themed dialog, replacing the blocking `window.confirm`.
 *
 * Requests queue rather than overwrite: two plugins asking for approval at
 * once would otherwise leave the first promise pending forever.
 */

import { useEffect, useRef, useState } from "react";
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
  const queueRef = useRef<readonly PendingConfirm[]>([]);
  queueRef.current = queue;

  useEffect(() => {
    const unsubscribe = subscribeConfirm((pending) =>
      setQueue((prev) => [...prev, pending]),
    );
    return () => {
      unsubscribe();
      // Every queued caller is awaiting a promise only this host can settle.
      // Unmounting without answering them would hang each one forever, so
      // treat a teardown as a decline.
      for (const pending of queueRef.current) pending.resolve(false);
    };
  }, []);

  const current = queue[0];

  const settle = (approved: boolean) => {
    if (!current) return;
    current.resolve(approved);
    // Remove by id rather than dropping the head: two clicks landing in the
    // same render both see this `current`, and a second `slice(1)` would evict
    // the NEXT request unanswered, hanging its caller. Filtering by id makes
    // the repeat a no-op (resolving a settled promise already is one).
    setQueue((prev) => prev.filter((entry) => entry.id !== current.id));
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
