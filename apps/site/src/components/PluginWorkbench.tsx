import { PluginExtensions } from "./PluginExtensions.js";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  Dices,
  GitBranch,
  RotateCcw,
  ScrollText,
  Search,
} from "lucide-react";
import type { Copy } from "../copy.js";
import { container, SectionHeading } from "./ui.js";
import { RelationshipExample } from "./RelationshipExample.js";

type WorkbenchCopy = Copy["workbench"];
const TABS = ["dice", "quests", "relationships", "codex"] as const;
type Tab = (typeof TABS)[number];
const ICONS = {
  dice: Dices,
  quests: ScrollText,
  relationships: GitBranch,
  codex: BookOpen,
};

/** Rejection sampling avoids modulo bias. This is a browser-only demonstration,
 * not a game runtime: no plugin code, persistence, model calls or network. */
function rollD20() {
  const random = new Uint32Array(1);
  do {
    crypto.getRandomValues(random);
  } while (random[0]! >= 4_294_967_280);
  return (random[0]! % 20) + 1;
}

function DiceExample({ copy }: { copy: WorkbenchCopy["dice"] }) {
  const [receipt, setReceipt] = useState<{
    roll: number;
    sequence: number;
  } | null>(null);
  const total = receipt ? receipt.roll + 4 : null;
  return (
    <div className="workbench-dice">
      <div className="workbench-card-heading">
        <span className="workbench-kicker">{copy.skill}</span>
        <span className="workbench-badge">D20 + 4</span>
      </div>
      <h4>{copy.label}</h4>
      <div className="workbench-dice-stage" aria-hidden="true">
        <span
          className="workbench-die"
          key={receipt?.sequence ?? 0}
          data-rolled={!!receipt}
        >
          {receipt?.roll ?? "?"}
        </span>
        <span className="workbench-dice-equation">
          + 4 <span>= {total ?? "—"}</span>
        </span>
      </div>
      <div
        className="workbench-receipt"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {receipt && total !== null ? (
          <>
            <p className="workbench-kicker">{copy.result}</p>
            <p className="workbench-outcome">
              {total >= 16 ? copy.success : copy.failure}
              <span>
                {copy.die} {receipt.roll} + 4 = {total} / {copy.target} 16
              </span>
            </p>
            <p>{total >= 16 ? copy.successText : copy.failureText}</p>
          </>
        ) : (
          <>
            <p className="workbench-kicker">{copy.result}</p>
            <p>{copy.waiting}</p>
            <p>{copy.rule}</p>
          </>
        )}
      </div>
      <div className="workbench-action-row">
        <button
          type="button"
          className="workbench-button"
          onClick={() =>
            setReceipt((previous) => ({
              roll: rollD20(),
              sequence: (previous?.sequence ?? 0) + 1,
            }))
          }
        >
          <Dices aria-hidden="true" size={17} />
          {receipt ? copy.again : copy.roll}
        </button>
        <span className="workbench-meta">
          {copy.target} 16 · {copy.modifier} +4
        </span>
      </div>
    </div>
  );
}

function QuestExample({ copy }: { copy: WorkbenchCopy["quest"] }) {
  const [completed, setCompleted] = useState(0);
  const finished = completed === copy.objectives.length;
  return (
    <div className="workbench-quest">
      <div className="workbench-card-heading">
        <span className="workbench-kicker">{copy.label}</span>
        <span className="workbench-badge">
          {finished ? copy.complete : copy.active}
        </span>
      </div>
      <h4>{copy.title}</h4>
      <p className="workbench-meta">{copy.giver}</p>
      <details className="workbench-details">
        <summary>
          {copy.details}
          <ChevronRight size={15} aria-hidden="true" />
        </summary>
        <p>{copy.description}</p>
      </details>
      <ol className="workbench-objectives">
        {copy.objectives.map((objective, index) => (
          <li key={objective} data-completed={index < completed}>
            <span
              className="workbench-objective-marker"
              aria-label={
                index < completed ? copy.completedLabel : copy.pendingLabel
              }
            >
              {index < completed ? (
                <Check size={13} aria-hidden="true" />
              ) : (
                index + 1
              )}
            </span>
            <span>{objective}</span>
          </li>
        ))}
      </ol>
      <div className="workbench-progress">
        <progress
          value={completed}
          max={copy.objectives.length}
          aria-label={copy.progress}
        />
        <span role="status">
          {copy.progress} {completed}/{copy.objectives.length}
        </span>
      </div>
      <div className="workbench-action-row">
        <button
          type="button"
          className="workbench-button"
          disabled={finished}
          onClick={() =>
            setCompleted((value) => Math.min(value + 1, copy.objectives.length))
          }
        >
          {finished ? (
            <Check size={17} aria-hidden="true" />
          ) : (
            <ArrowRight size={17} aria-hidden="true" />
          )}
          {finished ? copy.complete : copy.advance}
        </button>
        {finished && <span className="workbench-meta">{copy.finished}</span>}
      </div>
    </div>
  );
}

function CodexExample({ copy }: { copy: WorkbenchCopy["codex"] }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const id = useId();
  const entries = copy.entries.filter(
    (entry) =>
      (category === "all" || entry.category === category) &&
      `${entry.title} ${entry.body} ${entry.tag}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <div className="workbench-codex">
      <p className="workbench-kicker">{copy.label}</p>
      <div className="workbench-filters">
        <div>
          <label htmlFor={`${id}-search`}>{copy.search}</label>
          <div className="workbench-search">
            <Search size={15} aria-hidden="true" />
            <input
              id={`${id}-search`}
              type="search"
              placeholder={copy.placeholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
        <div>
          <label htmlFor={`${id}-category`}>{copy.filter}</label>
          <select
            id={`${id}-category`}
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="all">{copy.all}</option>
            <option value="location">{copy.locations}</option>
            <option value="lore">{copy.lore}</option>
          </select>
        </div>
      </div>
      <p className="workbench-meta workbench-result-count" role="status">
        {copy.count}: {entries.length}
      </p>
      <div className="workbench-entries">
        {entries.map((entry) => (
          <details className="workbench-entry" key={entry.title}>
            <summary>
              <BookOpen aria-hidden="true" size={17} />
              <span>
                <strong>{entry.title}</strong>
                <span>{entry.tag}</span>
              </span>
              <ChevronRight size={17} aria-hidden="true" />
            </summary>
            <p>{entry.body}</p>
          </details>
        ))}
        {entries.length === 0 && (
          <div className="workbench-empty">
            <p>{copy.empty}</p>
            <button
              type="button"
              className="workbench-button workbench-button-quiet"
              onClick={() => {
                setQuery("");
                setCategory("all");
              }}
            >
              {copy.clear}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function PluginWorkbench({ copy }: { copy: Copy }) {
  const content = copy.workbench;
  const [active, setActive] = useState<Tab>("dice");
  const [reset, setReset] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();
  const intro = content.intros[active];
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = (index + 1) % TABS.length;
        break;
      case "ArrowLeft":
        next = (index + TABS.length - 1) % TABS.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = TABS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = TABS[next];
    if (target) {
      setActive(target);
      tabs.current[next]?.focus();
    }
  }
  return (
    <section
      id="plugins"
      aria-labelledby="plugins-title"
      className="workbench-section border-t border-line py-24 sm:py-32"
    >
      <div className={container}>
        <SectionHeading
          id="plugins-title"
          eyebrow={content.eyebrow}
          title={content.title}
        >
          {content.body}
        </SectionHeading>
        <div className="workbench-shell">
          <div className="workbench-topline">
            <span className="workbench-kicker">{content.example}</span>
            <span>{content.world}</span>
          </div>
          <div
            className="workbench-tabs"
            role="tablist"
            aria-label={content.tabLabel}
          >
            {TABS.map((tab, index) => {
              const Icon = ICONS[tab];
              return (
                <button
                  type="button"
                  role="tab"
                  id={`${id}-tab-${tab}`}
                  aria-controls={`${id}-panel-${tab}`}
                  aria-selected={active === tab}
                  tabIndex={active === tab ? 0 : -1}
                  ref={(element) => {
                    tabs.current[index] = element;
                  }}
                  key={tab}
                  onClick={() => setActive(tab)}
                  onKeyDown={(event) => navigate(event, index)}
                >
                  <Icon size={18} aria-hidden="true" />
                  <span>{content.tabs[tab]}</span>
                </button>
              );
            })}
          </div>
          {TABS.map((tab) => (
            <div
              key={tab}
              role="tabpanel"
              id={`${id}-panel-${tab}`}
              aria-labelledby={`${id}-tab-${tab}`}
              hidden={active !== tab}
              tabIndex={0}
              className="workbench-panel"
            >
              {active === tab && (
                <>
                  <div className="workbench-intro">
                    <span className="workbench-panel-number" aria-hidden="true">
                      0{TABS.indexOf(tab) + 1} / 04
                    </span>
                    <h3>{intro.title}</h3>
                    <p>{intro.body}</p>
                    <p className="workbench-footnote">{intro.foot}</p>
                  </div>
                  <div className="workbench-demo" key={`${tab}-${reset}`}>
                    {tab === "dice" && <DiceExample copy={content.dice} />}
                    {tab === "quests" && <QuestExample copy={content.quest} />}
                    {tab === "relationships" && (
                      <RelationshipExample copy={content.relationships} />
                    )}
                    {tab === "codex" && <CodexExample copy={content.codex} />}
                  </div>
                </>
              )}
            </div>
          ))}
          <div className="workbench-footer">
            <p>{content.note}</p>
            <button
              type="button"
              className="workbench-reset"
              onClick={() => setReset((value) => value + 1)}
            >
              <RotateCcw size={14} aria-hidden="true" />
              {content.reset}
            </button>
          </div>
        </div>
        <PluginExtensions copy={copy} />
      </div>
    </section>
  );
}
