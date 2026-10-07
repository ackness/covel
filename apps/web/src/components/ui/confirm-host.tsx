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
import { isImeComposing } from "@/lib/ime-composition.js";

/** Controls on which Enter already does something of its own. */
const OWN_ENTER_SELECTOR = "button, a[href], input, select, textarea";

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

  // A multi-item prompt starts with every entry ticked: the player opted into
  // each of them already, and unticks the ones to leave out.
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const currentId = current?.id;
  useEffect(() => {
    setChecked(new Set(queueRef.current[0]?.choices?.map((c) => c.id) ?? []));
  }, [currentId]);

  const settle = (approved: boolean) => {
    if (!current) return;
    current.resolve(
      approved,
      approved
        ? current.choices
            ?.filter((choice) => checked.has(choice.id))
            .map((choice) => choice.id)
        : undefined,
    );
    // Remove by id rather than dropping the head: two clicks landing in the
    // same render both see this `current`, and a second `slice(1)` would evict
    // the NEXT request unanswered, hanging its caller. Filtering by id makes
    // the repeat a no-op (resolving a settled promise already is one).
    setQueue((prev) => prev.filter((entry) => entry.id !== current.id));
  };

  const confirmDisabled = current?.choices !== undefined && checked.size === 0;

  return (
    <Dialog
      open={current !== undefined}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onKeyDown={(event) => {
          if (event.key !== "Enter" || isImeComposing(event)) return;
          // Enter approves only while no control has the focus. On a control
          // it keeps that control's own meaning: the dialog opens with the
          // focus on Cancel, and Enter there has to cancel. A prompt with
          // entries to tick is approved with its button, never in passing.
          const target = event.target;
          if (
            current?.choices ||
            (target instanceof Element && target.closest(OWN_ENTER_SELECTOR))
          )
            return;
          event.preventDefault();
          settle(true);
        }}
      >
        <DialogHeader>
          <DialogTitle>{current?.title}</DialogTitle>
          <DialogDescription className="whitespace-pre-line pt-1 wrap-anywhere">
            {current?.message}
          </DialogDescription>
        </DialogHeader>
        {current?.subject && (
          <p className="bg-muted px-2 py-1.5 text-sm font-medium wrap-anywhere">
            {current.subject}
          </p>
        )}
        {current?.choices && (
          <ul className="max-h-64 space-y-2 overflow-y-auto">
            {current.choices.map((choice) => (
              <li key={choice.id}>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={checked.has(choice.id)}
                    onChange={(event) => {
                      const next = new Set(checked);
                      if (event.target.checked) next.add(choice.id);
                      else next.delete(choice.id);
                      setChecked(next);
                    }}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{choice.label}</span>
                    {choice.detail && (
                      <span className="block text-xs text-muted-foreground wrap-break-word">
                        {choice.detail}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => settle(false)}>
            {current?.cancelLabel}
          </Button>
          <Button
            size="sm"
            variant={current?.destructive ? "destructive" : "default"}
            disabled={confirmDisabled}
            onClick={() => settle(true)}
          >
            {current?.confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
