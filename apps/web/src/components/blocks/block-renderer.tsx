/**
 * Block Renderer — Three-Tier Resolution
 *
 * Tier 1: Custom Renderer — hand-written React component (highest quality)
 * Tier 2: Schema Renderer — auto-generated from plugin blockSchemas
 * Tier 3: Raw Fallback — JSON display (development/debug)
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SchemaBlockRenderer } from "./schema-block-renderer.js";
import type { BlockSchemaDeclaration } from "@covel/shared";
import {
  Dices,
  Swords,
  ScrollText,
  Backpack,
  Sword,
  Shield,
  FlaskConical,
  Gem,
  Layers,
  Package,
  ChevronRight,
  Coins,
  Square,
  SquareCheckBig,
  Users,
  CheckCircle2,
} from "lucide-react";
import { ActionGuideBlock } from "./action-guide-block.js";
import { CodexEntryBlock } from "./codex-entry-block.js";
import { StoryImageBlock } from "./story-image-block.js";
import { NotificationBlock } from "./notification-block.js";
import { LootBlock } from "./loot-block.js";
import { ItemUpdateBlock } from "./item-update-block.js";
import { StatusEffectBlock } from "./status-effect-block.js";
import { RelationshipBlock } from "./relationship-block.js";
import { ReputationBlock } from "./reputation-block.js";
import { SceneUpdateBlock } from "./scene-update-block.js";

// ── Types ──────────────────────────────────────────────────────────

export interface BlockRendererProps {
  /** Block data payload from the server. */
  data: Record<string, unknown>;
  /** Callback to send a message/response back to the server. */
  onSubmit: (value: string) => void;
  /** Callback to record a selection without submitting (for multi-block collect-then-submit). */
  onSelect?: (value: string) => void;
  /** The currently selected value (controlled by parent for multi-block mode). */
  selectedValue?: string | null;
  /** Whether the session is currently executing (disable interactions). */
  disabled?: boolean;
}

type BlockRendererComponent = React.ComponentType<BlockRendererProps>;

// ── Tier 1: Custom Renderers ──────────────────────────────────────

const CUSTOM_RENDERERS: Record<string, BlockRendererComponent> = {
  choice_set: ChoiceSetBlock,
  character_creation: CharacterCreationBlock,
  dice_result: DiceResultBlock,
  combat_status: CombatStatusBlock,
  quest_log: QuestLogBlock,
  inventory_panel: InventoryPanelBlock,
  npc_init_summary: NpcInitSummaryBlock,
  action_guide: ActionGuideBlock,
  codex_entry: CodexEntryBlock,
  story_image: StoryImageBlock,
  notification: NotificationBlock,
  loot: LootBlock,
  item_update: ItemUpdateBlock,
  status_effect: StatusEffectBlock,
  relationship_change: RelationshipBlock,
  reputation_change: ReputationBlock,
  scene_update: SceneUpdateBlock,
};

// ── Tier 2: Schema Registry ──────────────────────────────────────

// Module-level mutable state: intentional singleton registry shared across all
// React component instances. Updated once at boot via setBlockSchemas() and
// read by getBlockRenderer() during render. Not placed in React context because
// it must be accessible outside the component tree (e.g. in resolution helpers).
let blockSchemas: Record<string, BlockSchemaDeclaration> = {};

export function setBlockSchemas(schemas: Record<string, BlockSchemaDeclaration>) {
  blockSchemas = schemas;
}

export function getBlockSchemas(): Record<string, BlockSchemaDeclaration> {
  return blockSchemas;
}

// ── Resolution ────────────────────────────────────────────────────

export interface BlockResolution {
  mode: "custom" | "schema" | "raw";
  component?: BlockRendererComponent;
  schema?: BlockSchemaDeclaration;
}

export function resolveBlockRenderer(blockType: string): BlockResolution {
  if (CUSTOM_RENDERERS[blockType]) {
    return { mode: "custom", component: CUSTOM_RENDERERS[blockType] };
  }
  if (blockSchemas[blockType]) {
    return { mode: "schema", schema: blockSchemas[blockType] };
  }
  return { mode: "raw" };
}

/**
 * Legacy API — resolve to a renderable component.
 * Returns null only if no custom renderer AND no schema available (raw fallback).
 */
export function getBlockRenderer(blockType: string): BlockRendererComponent | null {
  const resolution = resolveBlockRenderer(blockType);

  if (resolution.mode === "custom" && resolution.component) {
    return resolution.component;
  }

  if (resolution.mode === "schema" && resolution.schema) {
    const schema = resolution.schema;
    return function SchemaBlock(props: BlockRendererProps) {
      return (
        <SchemaBlockRenderer
          schema={schema}
          data={props.data}
          onSubmit={props.onSubmit}
          disabled={props.disabled}
        />
      );
    };
  }

  return null;
}

// ── choice_set ─────────────────────────────────────────────────────

function ChoiceSetBlock({ data, onSubmit, onSelect, selectedValue, disabled }: BlockRendererProps) {
  const title = data.title as string | undefined;
  const options = (data.options as Array<{ id: string; label: string }>) ?? [];
  const handleClick = onSelect ?? onSubmit;

  return (
    <Card className="max-w-md">
      <CardHeader className="py-3 px-4 border-b border-border">
        <CardTitle className="text-sm">{title ?? "Choose"}</CardTitle>
      </CardHeader>
      <CardContent className="p-2">
        {options.map((opt) => (
          <Button
            key={opt.id}
            variant={selectedValue === opt.label ? "default" : "ghost"}
            className="w-full justify-start rounded-none text-sm h-auto py-3 px-4"
            disabled={disabled}
            onClick={() => handleClick(opt.label)}
          >
            {opt.label}
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}

// ── character_creation ─────────────────────────────────────────────

interface CharacterField {
  id: string;
  type: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  options?: string[];
  min?: number;
  max?: number;
  defaultValue?: unknown;
}

function CharacterCreationBlock({ data, onSubmit, disabled }: BlockRendererProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    const initFields = (data.fields as CharacterField[]) ?? [];
    for (const f of initFields) {
      if (f.defaultValue != null) {
        initial[f.id] = String(f.defaultValue);
      }
    }
    return initial;
  });

  const fields = (data.fields as CharacterField[]) ?? [];
  const { t } = useTranslation();
  const submitLabel = (data.submitLabel as string) ?? t("common.confirm");
  const submitMapping = (data.submitMapping as Record<string, string>) ?? {};

  const handleFieldChange = (fieldId: string, value: string) => {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
  };

  const handleSubmit = () => {
    // When submitMapping is present, build a structured JSON payload
    if (Object.keys(submitMapping).length > 0) {
      const payload: Record<string, unknown> = {};
      for (const [fieldId, path] of Object.entries(submitMapping)) {
        const raw = values[fieldId]?.trim() ?? "";
        if (!raw) continue;
        // Support dot-path notation (e.g. "fields.occupation")
        const segments = path.split(".");
        let target: Record<string, unknown> = payload;
        for (let i = 0; i < segments.length - 1; i++) {
          const seg = segments[i];
          if (!(seg in target) || typeof target[seg] !== "object") {
            target[seg] = {};
          }
          target = target[seg] as Record<string, unknown>;
        }
        target[segments[segments.length - 1]] = raw;
      }
      onSubmit(JSON.stringify(payload));
    } else if (fields.length === 1) {
      const value = values[fields[0].id]?.trim();
      if (value) onSubmit(value);
    } else {
      const parts = fields
        .map((f) => values[f.id]?.trim())
        .filter(Boolean);
      if (parts.length > 0) onSubmit(parts.join(", "));
    }
  };

  const canSubmit = fields
    .filter((f) => f.required)
    .every((f) => values[f.id]?.trim());

  const hasMultipleFields = fields.length > 1;

  // Single field: inline row layout (original style)
  if (!hasMultipleFields) {
    return (
      <div className="flex items-center gap-2 max-w-md">
        {fields.map((field) => (
          <input
            key={field.id}
            id={`block-field-${field.id}`}
            type="text"
            placeholder={field.placeholder ?? field.label}
            value={values[field.id] ?? ""}
            onChange={(e) => handleFieldChange(field.id, e.target.value)}
            disabled={disabled}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit && !disabled) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            className="flex-1 bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary transition-all disabled:opacity-50"
          />
        ))}
        <Button
          size="sm"
          className="rounded-none uppercase tracking-widest text-xs font-semibold shrink-0 px-6"
          disabled={disabled || !canSubmit}
          onClick={handleSubmit}
        >
          {submitLabel}
        </Button>
      </div>
    );
  }

  // Multiple fields: stacked form layout
  return (
    <Card className="max-w-md">
      <CardContent className="p-4 space-y-3">
        {fields.map((field) => (
          <CharacterFieldInput
            key={field.id}
            field={field}
            value={values[field.id] ?? ""}
            disabled={disabled}
            onChange={(v) => handleFieldChange(field.id, v)}
          />
        ))}
        <Button
          size="sm"
          className="w-full rounded-none uppercase tracking-widest text-xs font-semibold px-6"
          disabled={disabled || !canSubmit}
          onClick={handleSubmit}
        >
          {submitLabel}
        </Button>
      </CardContent>
    </Card>
  );
}

function CharacterFieldInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: CharacterField;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const fieldType = field.type;

  const baseInputClass =
    "w-full bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary transition-all disabled:opacity-50";

  if (fieldType === "select" && field.options) {
    return (
      <div className="space-y-1">
        <Label htmlFor={`block-field-${field.id}`} className="text-xs">
          {field.label}
          {field.required && <span className="text-red-500 ml-0.5">*</span>}
        </Label>
        <select
          id={`block-field-${field.id}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={baseInputClass}
        >
          <option value="">{field.placeholder ?? field.label}</option>
          {field.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (fieldType === "number") {
    return (
      <div className="space-y-1">
        <Label htmlFor={`block-field-${field.id}`} className="text-xs">
          {field.label}
          {field.required && <span className="text-red-500 ml-0.5">*</span>}
        </Label>
        <input
          id={`block-field-${field.id}`}
          type="number"
          min={field.min}
          max={field.max}
          placeholder={field.placeholder ?? field.label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={baseInputClass}
        />
      </div>
    );
  }

  if (fieldType === "boolean") {
    return (
      <div className="flex items-center gap-2">
        <input
          id={`block-field-${field.id}`}
          type="checkbox"
          checked={value === "true"}
          onChange={(e) => onChange(e.target.checked ? "true" : "false")}
          disabled={disabled}
          className="h-4 w-4 accent-primary"
        />
        <Label htmlFor={`block-field-${field.id}`} className="text-xs">
          {field.label}
        </Label>
      </div>
    );
  }

  // Default: text / string
  return (
    <div className="space-y-1">
      <Label htmlFor={`block-field-${field.id}`} className="text-xs">
        {field.label}
        {field.required && <span className="text-red-500 ml-0.5">*</span>}
      </Label>
      <input
        id={`block-field-${field.id}`}
        type="text"
        placeholder={field.placeholder ?? field.label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={baseInputClass}
      />
    </div>
  );
}

// ── dice_result ───────────────────────────────────────────────────

type DiceOutcome = "critical_success" | "success" | "failure" | "critical_failure";

const OUTCOME_STYLES: Record<DiceOutcome, { bg: string; text: string; label: string }> = {
  critical_success: { bg: "bg-amber-500/15 dark:bg-amber-500/20", text: "text-amber-600 dark:text-amber-400", label: "CRITICAL SUCCESS" },
  success:          { bg: "bg-green-500/15 dark:bg-green-500/20", text: "text-green-600 dark:text-green-400", label: "SUCCESS" },
  failure:          { bg: "bg-red-500/15 dark:bg-red-500/20",     text: "text-red-500 dark:text-red-400",     label: "FAILURE" },
  critical_failure: { bg: "bg-red-800/15 dark:bg-red-900/25",     text: "text-red-700 dark:text-red-500",     label: "CRITICAL FAILURE" },
};

function DiceResultBlock({ data }: BlockRendererProps) {
  const outcome = (data.outcome as DiceOutcome) ?? "success";
  const roll = data.roll as { total: number; rolls: number[]; modifier: number; expression: string } | undefined;
  const dc = data.dc as number | undefined;
  const total = data.total as number | undefined;
  const margin = data.margin as number | undefined;
  const skill = data.skill as string | undefined;

  const style = OUTCOME_STYLES[outcome] ?? OUTCOME_STYLES.success;

  return (
    <div className={`inline-flex items-center gap-3 rounded border border-border px-3 py-2 ${style.bg} animate-in fade-in duration-300`}>
      <Dices className={`h-5 w-5 shrink-0 ${style.text}`} />

      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          {roll && (
            <span className="font-mono text-sm text-muted-foreground">{roll.expression}</span>
          )}
          {skill && (
            <span className="text-xs uppercase tracking-widest text-muted-foreground">{skill}</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className={`font-mono text-base font-bold ${style.text}`}>
            {total ?? roll?.total ?? "—"}
          </span>
          {dc != null && (
            <span className="text-xs text-muted-foreground">
              DC {dc}
            </span>
          )}
          {margin != null && (
            <span className={`text-xs font-mono ${margin >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}>
              {margin >= 0 ? `+${margin}` : margin}
            </span>
          )}
        </div>
      </div>

      <Badge variant="outline" className={`ml-1 rounded-none border-0 text-[10px] uppercase tracking-widest font-semibold ${style.text} ${style.bg}`}>
        {style.label}
      </Badge>
    </div>
  );
}

// ── combat_status ─────────────────────────────────────────────────

interface CombatParticipant {
  id: string;
  name: string;
  type: "player" | "ally" | "enemy";
  hp: number;
  maxHp: number;
  initiative: number;
  statusEffects: Array<{ name: string; duration: number }>;
  isDefeated: boolean;
}

const PARTICIPANT_COLORS: Record<string, { bar: string; text: string }> = {
  player: { bar: "bg-green-500 dark:bg-green-600", text: "text-green-600 dark:text-green-400" },
  ally:   { bar: "bg-emerald-400 dark:bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  enemy:  { bar: "bg-red-500 dark:bg-red-600", text: "text-red-500 dark:text-red-400" },
};

function CombatStatusBlock({ data }: BlockRendererProps) {
  const roundNumber = data.roundNumber as number | undefined;
  const participants = (data.participants as CombatParticipant[]) ?? [];
  const currentTurnIndex = data.currentTurnIndex as number | undefined;
  const summary = data.summary as string | undefined;

  return (
    <Card className="max-w-lg">
      <CardHeader className="py-3 px-4 border-b border-border">
        <CardTitle className="text-xs uppercase tracking-widest flex items-center gap-2">
          <Swords className="h-4 w-4" />
          Round {roundNumber ?? "—"}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {summary && (
          <p className="px-4 py-2 text-xs text-muted-foreground border-b border-border italic">{summary}</p>
        )}
        <div className="divide-y divide-border">
          {participants.map((p, idx) => {
            const colors = PARTICIPANT_COLORS[p.type] ?? PARTICIPANT_COLORS.enemy;
            const isCurrent = idx === currentTurnIndex;
            const hpPct = p.maxHp > 0 ? Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100)) : 0;

            return (
              <div
                key={p.id}
                className={`flex items-center gap-3 px-4 py-2 text-sm ${p.isDefeated ? "opacity-40" : ""} ${isCurrent ? "bg-muted/50" : ""}`}
              >
                {isCurrent && (
                  <ChevronRight className="h-3 w-3 shrink-0 text-foreground" />
                )}
                {!isCurrent && <span className="w-3 shrink-0" />}

                <span className={`font-mono w-6 text-right text-xs text-muted-foreground`}>{p.initiative}</span>

                <span className={`flex-1 text-sm font-medium ${p.isDefeated ? "line-through text-muted-foreground" : colors.text}`}>
                  {p.name}
                </span>

                <div className="flex items-center gap-1.5">
                  {p.statusEffects.map((effect) => (
                    <Badge
                      key={effect.name}
                      variant="outline"
                      className="rounded-none text-[10px] uppercase tracking-widest py-0"
                    >
                      {effect.name}
                      {effect.duration > 0 && <span className="ml-0.5 opacity-60">{effect.duration}</span>}
                    </Badge>
                  ))}
                </div>

                <div className="w-24 flex items-center gap-1.5">
                  <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full transition-all duration-500 ${colors.bar}`}
                      style={{ width: `${hpPct}%` }}
                    />
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground w-12 text-right">
                    {p.hp}/{p.maxHp}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ── quest_log ─────────────────────────────────────────────────────

interface Quest {
  id: string;
  title: string;
  description: string;
  type: "main" | "side" | "hidden";
  status: "discovered" | "active" | "completed" | "failed";
  objectives: Array<{ id: string; description: string; completed: boolean; optional?: boolean }>;
}

const QUEST_STATUS_STYLES: Record<string, string> = {
  active:     "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  completed:  "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  failed:     "bg-red-500/15 text-red-500 dark:text-red-400 border-red-500/30",
  discovered: "bg-muted text-muted-foreground border-border",
};

const QUEST_TYPE_STYLES: Record<string, string> = {
  main:   "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  side:   "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  hidden: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
};

function QuestLogBlock({ data }: BlockRendererProps) {
  const quests = (data.quests as Quest[]) ?? [];

  return (
    <Card className="max-w-lg">
      <CardHeader className="py-3 px-4 border-b border-border">
        <CardTitle className="text-xs uppercase tracking-widest flex items-center gap-2">
          <ScrollText className="h-4 w-4" />
          Quest Log
        </CardTitle>
      </CardHeader>
      <CardContent className="p-2 space-y-1">
        {quests.map((q) => (
          <div key={q.id} className="border border-border p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <span className={`text-sm font-medium ${q.status === "completed" ? "line-through text-muted-foreground" : q.status === "failed" ? "line-through text-red-500 dark:text-red-400" : ""}`}>
                {q.title}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <Badge variant="outline" className={`rounded-none text-[10px] uppercase tracking-widest py-0 ${QUEST_TYPE_STYLES[q.type] ?? ""}`}>
                  {q.type}
                </Badge>
                <Badge variant="outline" className={`rounded-none text-[10px] uppercase tracking-widest py-0 ${QUEST_STATUS_STYLES[q.status] ?? ""}`}>
                  {q.status}
                </Badge>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">{q.description}</p>

            {q.objectives.length > 0 && (
              <ul className="space-y-0.5">
                {q.objectives.map((obj) => (
                  <li key={obj.id} className="flex items-start gap-1.5 text-xs">
                    {obj.completed ? (
                      <SquareCheckBig className="h-3.5 w-3.5 shrink-0 mt-px text-green-600 dark:text-green-400" />
                    ) : (
                      <Square className="h-3.5 w-3.5 shrink-0 mt-px text-muted-foreground" />
                    )}
                    <span className={`${obj.completed ? "line-through text-muted-foreground" : ""} ${obj.optional ? "italic" : ""}`}>
                      {obj.description}
                      {obj.optional && <span className="ml-1 text-muted-foreground">(optional)</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ── npc_init_summary ─────────────────────────────────────────────

function NpcInitSummaryBlock({ data }: BlockRendererProps) {
  const { t } = useTranslation();

  const npcCount = (data.npcCount as number) ?? 0;
  const summary = (data.summary as string) ?? "";
  const completedAt = data.completedAt as string | undefined;

  return (
    <div className="inline-flex items-center gap-3 rounded border border-border px-3 py-2 bg-green-500/10 dark:bg-green-500/15 animate-in fade-in duration-300">
      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-500/15 dark:bg-green-500/20">
        <Users className="h-4 w-4 text-green-600 dark:text-green-400" />
      </div>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
          <span className="text-sm font-medium text-green-700 dark:text-green-300">
            {t("session.npcInitComplete")}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t("session.npcInitCount", { count: npcCount })}</span>
          {completedAt && (
            <span className="opacity-60">
              {new Date(completedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
        {summary && (
          <p className="text-xs text-muted-foreground mt-0.5">{summary}</p>
        )}
      </div>
    </div>
  );
}

// ── inventory_panel ───────────────────────────────────────────────

interface InventoryItem {
  id: string;
  name: string;
  description: string;
  category: "weapon" | "armor" | "consumable" | "quest" | "material" | "misc";
  quantity: number;
  equipped?: boolean;
}

const CATEGORY_CONFIG: Record<string, { icon: typeof Sword; color: string; label: string }> = {
  weapon:     { icon: Sword,        color: "text-red-500 dark:text-red-400",     label: "Weapons" },
  armor:      { icon: Shield,       color: "text-blue-500 dark:text-blue-400",   label: "Armor" },
  consumable: { icon: FlaskConical, color: "text-green-500 dark:text-green-400", label: "Consumables" },
  quest:      { icon: Gem,          color: "text-amber-500 dark:text-amber-400", label: "Quest" },
  material:   { icon: Layers,       color: "text-gray-500 dark:text-gray-400",   label: "Materials" },
  misc:       { icon: Package,      color: "text-purple-500 dark:text-purple-400", label: "Misc" },
};

const CATEGORY_ORDER: string[] = ["weapon", "armor", "consumable", "quest", "material", "misc"];

function InventoryPanelBlock({ data }: BlockRendererProps) {
  const items = (data.items as InventoryItem[]) ?? [];
  const currency = (data.currency as Record<string, number>) ?? {};
  const capacity = data.capacity as number | undefined;

  const grouped = CATEGORY_ORDER.reduce<Record<string, InventoryItem[]>>((acc, cat) => {
    const catItems = items.filter((i) => i.category === cat);
    if (catItems.length > 0) {
      acc[cat] = catItems;
    }
    return acc;
  }, {});

  const currencyEntries = Object.entries(currency);

  return (
    <Card className="max-w-lg">
      <CardHeader className="py-3 px-4 border-b border-border">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xs uppercase tracking-widest flex items-center gap-2">
            <Backpack className="h-4 w-4" />
            Inventory
            {capacity != null && (
              <span className="text-muted-foreground font-normal ml-1">
                {items.length}/{capacity}
              </span>
            )}
          </CardTitle>
          {currencyEntries.length > 0 && (
            <div className="flex items-center gap-2">
              {currencyEntries.map(([name, amount]) => (
                <span key={name} className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Coins className="h-3 w-3 text-amber-500" />
                  <span className="font-mono">{amount}</span>
                  <span className="uppercase tracking-widest text-[10px]">{name}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-2 space-y-3">
        {Object.entries(grouped).map(([cat, catItems]) => {
          const config = CATEGORY_CONFIG[cat] ?? CATEGORY_CONFIG.misc;
          const CatIcon = config.icon;

          return (
            <div key={cat}>
              <div className={`flex items-center gap-1.5 px-1 mb-1 ${config.color}`}>
                <CatIcon className="h-3 w-3" />
                <span className="text-[10px] uppercase tracking-widest font-semibold">{config.label}</span>
              </div>
              <div className="grid grid-cols-2 gap-1">
                {catItems.map((item) => (
                  <div
                    key={item.id}
                    className={`border border-border px-2 py-1.5 text-xs ${item.equipped ? "bg-muted/50" : ""}`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-medium truncate">
                        {item.name}
                      </span>
                      <div className="flex items-center gap-1 shrink-0">
                        {item.equipped && (
                          <Badge variant="outline" className="rounded-none text-[9px] uppercase tracking-widest py-0 border-green-500/30 text-green-600 dark:text-green-400">
                            E
                          </Badge>
                        )}
                        {item.quantity > 1 && (
                          <span className="font-mono text-muted-foreground">x{item.quantity}</span>
                        )}
                      </div>
                    </div>
                    <p className="text-muted-foreground truncate mt-0.5">{item.description}</p>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
