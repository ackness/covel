/**
 * InputBar — player message input with send button.
 */

import { Send, X } from "lucide-react";
import type { PendingInteractionDraft } from "@/stores/session-store.js";

interface InputBarProps {
  value: string;
  onChange: (content: string) => void;
  onSend: () => void;
  pendingDrafts: PendingInteractionDraft[];
  onRemoveDraft: (id: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function InputBar({ value, onChange, onSend, pendingDrafts, onRemoveDraft, disabled, placeholder }: InputBarProps) {
  const hasDrafts = pendingDrafts.length > 0;
  const canSend = !disabled && (value.trim() || hasDrafts);

  return (
    <div className="border-t border-zinc-200 dark:border-zinc-700 px-4 py-3 space-y-2">
      {hasDrafts && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
            <span>已选择 {pendingDrafts.length} 项交互，可继续补充说明后统一发送。</span>
            <button
              type="button"
              onClick={() => pendingDrafts.forEach((draft) => onRemoveDraft(draft.id))}
              disabled={disabled}
              className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 disabled:opacity-30"
            >
              清空
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
          {pendingDrafts.map((draft) => (
            <span
              key={draft.id}
              className="inline-flex items-center gap-1 rounded-full border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/40 px-2 py-1 text-[11px] text-zinc-600 dark:text-zinc-300"
            >
              {draft.label}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onRemoveDraft(draft.id)}
                  className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-100"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          ))}
        </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
          disabled={disabled}
          placeholder={hasDrafts ? "补充你的说明，或直接点击统一发送…" : (placeholder ?? "输入你的行动...")}
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-400 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-500 hover:text-blue-500 hover:border-blue-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <Send className="w-4 h-4" />
          <span>{hasDrafts ? "统一发送" : "发送"}</span>
        </button>
      </div>
    </div>
  );
}
