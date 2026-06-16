import type { TFunction } from "i18next";
import { isAssetGenerateView } from "@covel/shared";
import { AssetRender } from "@/components/asset-render/index.js";
import type { StreamMessage } from "@/stores/session-store.js";
import {
  MessageBlockRenderer,
  PluginMessageBlock,
  UiRenderBlock,
} from "./message-blocks.js";
import {
  RawJsonBlock,
  SubmittedSelectionFooter,
} from "./message-primitives.js";

export interface ChatBlockRendererProps {
  readonly msg: StreamMessage;
  readonly index: number;
  readonly viewMode: "parsed" | "detailed" | "raw";
  readonly lastUserMsgIndex: number;
  readonly sessionId: string | undefined;
  readonly executing: boolean;
  readonly submittedBlockIds: ReadonlySet<string>;
  readonly submittedBlockValues: Readonly<
    Record<string, Record<string, unknown>>
  >;
  readonly onSendMessage: (msg: string) => void;
  readonly onSubmitBlock: (blockId: string) => void;
  readonly onSubmitInteraction?: (
    blockId: string,
    turnId: string,
    interactionId: string,
    type: "form" | "choice" | "confirmation",
    values: Record<string, unknown>,
    submitBehavior?: { echoFilledNarrative?: boolean },
  ) => Promise<void>;
  readonly t: TFunction;
}

/**
 * Renders a single block message. Interactive blocks are "locked" once a later
 * user message exists (index below the last user index — an O(1) check).
 */
export function ChatBlockRenderer({
  msg,
  index,
  viewMode,
  lastUserMsgIndex,
  sessionId,
  executing,
  submittedBlockIds,
  submittedBlockValues,
  onSendMessage,
  onSubmitBlock,
  onSubmitInteraction,
  t,
}: ChatBlockRendererProps) {
  const block = msg.block;
  if (!block) return null;
  const locked = lastUserMsgIndex >= 0 && index < lastUserMsgIndex;

  // Raw mode — show JSON for inspection.
  if (viewMode === "raw") {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
          {t("session.blockLabel", "Block")}: {block.type as string}
        </span>
        <RawJsonBlock content={JSON.stringify(block, null, 2)} />
      </div>
    );
  }

  const blockType = block.type as string;
  const submittedValues = submittedBlockValues[msg.id];

  // Plugin-message surface: plugins push json-render specs via ui.message and
  // state via plugin-data namespace=message. Each spec runs through
  // PluginPanel, which reads the live plugin-data store for reactive state.
  if (blockType === "plugin_message") {
    const pluginId =
      ((block.data as Record<string, unknown> | undefined)?.pluginId as
        | string
        | undefined) ?? msg.runtimeId;
    return (
      <div className="flex flex-col gap-1.5">
        {viewMode === "detailed" && pluginId && (
          <span className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">
            plugin · {pluginId}
          </span>
        )}
        <PluginMessageBlock
          block={block}
          sourceBlockId={msg.id}
          locked={locked}
        />
        <SubmittedSelectionFooter values={submittedValues} />
      </div>
    );
  }

  if (blockType === "ui.render") {
    return (
      <div className="flex flex-col gap-1.5">
        {viewMode === "detailed" && (
          <span className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">
            ui.render
            {msg.runtimeId && (
              <span className="ml-1.5 opacity-60">· {msg.runtimeId}</span>
            )}
          </span>
        )}
        <UiRenderBlock block={block} />
      </div>
    );
  }

  // NOTE: branch-reply blocks are NOT special-cased here. The branch-reply
  // plugin renders through the standard plugin-message surface (its
  // `ui.message` spec → `BranchReplyCandidates` catalog component), so the
  // framework never hardcodes the plugin's block type (CLAUDE.md isolation).

  const assetView = isAssetGenerateView(block.data) ? block.data : null;
  if (blockType === "asset.generate" && sessionId && assetView) {
    return (
      <div className="flex flex-col gap-1.5">
        {viewMode === "detailed" && (
          <span className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">
            asset · {assetView.modality}
          </span>
        )}
        <AssetRender view={assetView} sessionId={sessionId} />
      </div>
    );
  }

  // Every other block (interactive_form, notification, choice, …) resolves
  // through messageToSpec and json-render.
  return (
    <div className="flex flex-col gap-1.5">
      {viewMode === "detailed" && (msg.runtimeId || blockType) && (
        <span className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">
          {blockType ? `block · ${blockType}` : "block"}
          {msg.runtimeId && (
            <span className="ml-1.5 opacity-60">· {msg.runtimeId}</span>
          )}
        </span>
      )}
      <MessageBlockRenderer
        msg={msg}
        block={block}
        submitted={submittedBlockIds.has(msg.id) || locked}
        submittedValues={submittedValues}
        executing={executing}
        onSubmitInteraction={onSubmitInteraction}
        onSendMessage={onSendMessage}
        onSubmitBlock={onSubmitBlock}
      />
      <SubmittedSelectionFooter values={submittedValues} />
    </div>
  );
}
