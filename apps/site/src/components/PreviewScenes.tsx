import {
  BookOpen,
  Check,
  Compass,
  Dices,
  Feather,
  MapPin,
  Package,
  ScrollText,
  Radio,
  Battery,
  Clock,
  Heart,
  FileSearch,
} from "lucide-react";
import type { Copy, Visual } from "../copy.js";
import { PREVIEW_ART } from "../preview-copy.js";
import { asset } from "../links.js";

type SceneProps = { copy: Copy; beat: number };

// Layout references: web's StageHud / StageDialog / StageChoices,
// message-primitives and world-editor; plugin quest-log / inventory panels.
// Keep these read-only examples independent of session stores and plugin code.
function Stage({ copy, beat }: SceneProps) {
  const scene = copy.preview.stage;
  const state = copy.journey.stageState;
  return (
    <div className="preview-stage" data-beat={beat}>
      <img
        className="preview-backdrop preview-day"
        src={asset(PREVIEW_ART.stageDay)}
        alt=""
      />
      <img
        className="preview-backdrop preview-night"
        src={asset(PREVIEW_ART.stageNight)}
        alt=""
      />
      <div className="preview-location">
        <MapPin size={13} aria-hidden />
        {scene.location}
      </div>
      <img
        className="preview-character"
        src={asset(PREVIEW_ART.character)}
        alt=""
      />
      <aside
        className="preview-stage-state"
        data-focus={beat === 2}
        data-plugin="affinity"
      >
        <p>
          <Heart size={12} aria-hidden />
          {state.label}
        </p>
        <strong>{beat === 2 ? state.after : state.before}</strong>
        <small data-plugin="world-init">{state.route}</small>
      </aside>
      <div className="preview-dialog" data-plugin="chat-mode-narrator">
        <span className="preview-speaker">{scene.speaker}</span>
        <p className="preview-dialogue">{scene.dialogue}</p>
        <p className="preview-label">{scene.question}</p>
        <ol className="preview-choices">
          {scene.choices.map((choice, i) => (
            <li key={choice} data-selected={beat >= 1 && i === 0}>
              <span>{i + 1}</span>
              {choice}
            </li>
          ))}
        </ol>
        <p
          className="preview-stage-reply"
          data-revealed={beat >= 1}
          aria-hidden={beat < 1}
        >
          {state.reply}
        </p>
      </div>
    </div>
  );
}

function Tabletop({ copy, beat }: SceneProps) {
  const scene = copy.preview.tabletop;
  const state = copy.journey.tabletopState;
  return (
    <div className="preview-tabletop">
      <div className="preview-adventure">
        <img
          className="preview-adventure-art"
          src={asset(PREVIEW_ART.tabletop)}
          alt=""
        />
        <div className="preview-adventure-content">
          <p className="preview-label">
            <Compass size={14} aria-hidden />
            {scene.title}
          </p>
          <h3>{scene.chapter}</h3>
          <p>{scene.narrative}</p>
          <div
            className="preview-roll"
            data-focus={beat <= 1}
            data-plugin="dice-check"
          >
            <Dices size={30} aria-hidden />
            <div>
              <span className="preview-label">{scene.roll}</span>
              <strong>{scene.check}</strong>
              <span className="font-mono text-xs">
                {beat === 0 ? state.pending : scene.calculation}
              </span>
            </div>
            <span className="preview-result">
              <Check size={14} aria-hidden />
              {beat === 0 ? state.waiting : scene.result}
            </span>
          </div>
        </div>
      </div>
      <aside className="preview-panels" data-focus={beat === 2}>
        <div className="preview-card" data-plugin="core-quest">
          <p className="preview-label">
            <ScrollText size={14} aria-hidden />
            {scene.questLabel}
          </p>
          <h4>{scene.quest}</h4>
          <p>{beat === 2 ? state.done : scene.objective}</p>
          <div className="preview-progress" aria-hidden>
            <span style={{ width: beat === 2 ? "67%" : "33%" }} />
          </div>
          <small>{beat === 2 ? state.after : state.before}</small>
        </div>
        <div className="preview-card" data-plugin="inventory">
          <p className="preview-label">
            <Package size={14} aria-hidden />
            {scene.inventoryLabel}
          </p>
          <ul>
            {scene.items.map((item, index) => (
              <li key={item}>
                {item}
                <span>× {[3, 1, 2][index]}</span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}

function Story({ copy, beat }: SceneProps) {
  const scene = copy.preview.story;
  const state = copy.journey.storyState;
  return (
    <div className="preview-story">
      <div className="preview-story-art">
        <img src={asset(PREVIEW_ART.story)} alt="" />
        <span>{scene.title}</span>
      </div>
      <article className="preview-story-page">
        <p className="preview-label">
          <BookOpen size={14} aria-hidden />
          {scene.turn}
        </p>
        <h3>{scene.chapter}</h3>
        {scene.paragraphs.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
        <blockquote>{scene.quote}</blockquote>
        <p className="preview-player">{scene.player}</p>
        <ul className="preview-suggestions">
          {scene.choices.map((choice) => (
            <li key={choice}>{choice}</li>
          ))}
        </ul>
        <div className="preview-investigation">
          <div
            className="preview-evidence"
            data-focus={beat === 1}
            data-plugin="codex"
          >
            <p className="preview-label">
              <BookOpen size={12} aria-hidden />
              {state.label}
            </p>
            <strong>{state.entry}</strong>
            <p>{state.description}</p>
          </div>
          <div
            className="preview-evidence"
            data-focus={beat === 2}
            data-plugin="world-init"
          >
            <p className="preview-label">
              <FileSearch size={12} aria-hidden />
              {state.caseLabel}
            </p>
            <strong>{beat === 2 ? state.after : state.before}</strong>
            <p data-plugin="memory">{state.memory}</p>
          </div>
        </div>
        <div className="preview-composer">
          <Feather size={14} aria-hidden />
          {scene.composer}
        </div>
      </article>
    </div>
  );
}

function Survival({ copy, beat }: SceneProps) {
  const scene = copy.preview.survival;
  const state = copy.journey.survivalState;
  return (
    <div className="preview-survival">
      <div className="preview-survival-story">
        <img
          className="preview-survival-art"
          src={asset(PREVIEW_ART.survival)}
          alt=""
        />
        <div className="preview-survival-content">
          <p className="preview-label">
            <Radio size={14} aria-hidden />
            {scene.signalLabel}
          </p>
          <h3>{scene.chapter}</h3>
          <blockquote>{scene.signal}</blockquote>
          <p>{scene.narrative}</p>
        </div>
      </div>
      <aside
        className="preview-survival-panels"
        data-plugin="world-init"
        data-focus={beat === 2}
      >
        <p className="preview-label">{scene.statusLabel}</p>
        <div className="preview-card">
          <p className="preview-label">
            <Clock size={14} aria-hidden />
            {scene.stormLabel}
          </p>
          <p className="preview-readout">
            {beat === 2 ? "02:50:00" : scene.storm}
          </p>
        </div>
        <div className="preview-card">
          <p className="preview-label">
            <Battery size={14} aria-hidden />
            {scene.powerLabel}
          </p>
          <p className="preview-readout">
            {beat === 2 ? scene.power - 3 : scene.power}
            <small> / 100</small>
          </p>
          <div className="preview-power" aria-hidden>
            <span
              style={{
                width: `${beat === 2 ? scene.power - 3 : scene.power}%`,
              }}
            />
          </div>
        </div>
        <div
          className="preview-rescue-task"
          data-plugin="core-quest"
          data-focus={beat === 1}
        >
          <p className="preview-label">
            <ScrollText size={12} aria-hidden />
            {state.questLabel}
          </p>
          <strong>{state.quest}</strong>
          <p data-plugin="inventory">{state.equipment}</p>
          <p className="preview-change">
            {beat === 2 ? `${state.elapsed} · ${state.cost}` : state.before}
          </p>
        </div>
        <div>
          <p className="preview-label">{scene.taskLabel}</p>
          <ol className="preview-choices">
            {scene.choices.map((choice, index) => (
              <li key={choice}>
                <span>{index + 1}</span>
                {choice}
              </li>
            ))}
          </ol>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            {scene.note}
          </p>
        </div>
      </aside>
    </div>
  );
}

const SCENES = {
  stage: Stage,
  tabletop: Tabletop,
  story: Story,
  survival: Survival,
} satisfies Record<Visual, React.ComponentType<SceneProps>>;

export function PreviewScene({
  copy,
  visual,
  beat,
}: SceneProps & { visual: Visual }) {
  const Scene = SCENES[visual];
  return <Scene copy={copy} beat={beat} />;
}
