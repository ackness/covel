import { useId, useState } from "react";
import { ArrowRight, UserRound } from "lucide-react";
import type { Copy } from "../copy.js";

type RelationshipCopy = Copy["workbench"]["relationships"];
const POSITIONS: Record<string, { x: number; y: number }> = {
  wren: { x: 24, y: 23 },
  brannoc: { x: 76, y: 23 },
  mirelle: { x: 76, y: 77 },
  ysolde: { x: 24, y: 77 },
};

/** A small, static illustration of the graph panel's selection model.
 * HTML buttons keep every node reachable without interpreting SVG geometry. */
export function RelationshipExample({ copy }: { copy: RelationshipCopy }) {
  const [selected, setSelected] = useState("wren");
  const id = useId();
  const character = copy.characters.find((person) => person.key === selected);
  if (!character) return null;
  const connections = copy.edges.filter(
    (edge) => edge.source === selected || edge.target === selected,
  );
  const connected = new Set(
    connections.flatMap((edge) => [edge.source, edge.target]),
  );
  const personName = (key: string) =>
    copy.characters.find((person) => person.key === key)?.name;

  return (
    <div className="workbench-relationships">
      <div className="workbench-card-heading">
        <span className="workbench-kicker">{copy.label}</span>
        <span className="workbench-meta">{copy.sample}</span>
      </div>
      <p className="workbench-meta" id={`${id}-hint`}>
        {copy.hint}
      </p>
      <div
        className="workbench-graph"
        role="group"
        aria-label={copy.graph}
        aria-describedby={`${id}-hint`}
      >
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          {copy.edges.map((edge) => {
            const source = POSITIONS[edge.source];
            const target = POSITIONS[edge.target];
            if (!source || !target) return null;
            return (
              <line
                key={`${edge.source}-${edge.target}`}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                data-tone={edge.tone}
                data-active={
                  edge.source === selected || edge.target === selected
                }
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>
        {copy.characters.map((person) => {
          const position = POSITIONS[person.key];
          if (!position) return null;
          return (
            <button
              key={person.key}
              type="button"
              className="workbench-graph-node"
              style={{ left: `${position.x}%`, top: `${position.y}%` }}
              aria-label={`${person.name} · ${person.role}`}
              aria-pressed={selected === person.key}
              aria-controls={`${id}-profile`}
              data-connected={connected.has(person.key)}
              onClick={() => setSelected(person.key)}
            >
              <span className="workbench-graph-avatar" aria-hidden="true">
                <UserRound size={17} />
              </span>
              <span>{person.shortName}</span>
            </button>
          );
        })}
      </div>
      <div className="workbench-graph-legend" aria-label={copy.connections}>
        <span data-tone="positive">{copy.positive}</span>
        <span data-tone="neutral">{copy.neutralRelation}</span>
      </div>
      <div
        id={`${id}-profile`}
        className="workbench-person"
        role="region"
        aria-label={copy.profile}
        aria-live="polite"
        aria-atomic="true"
      >
        <div className="workbench-profile-heading">
          <h4>{character.name}</h4>
          <span className="workbench-meta">{character.role}</span>
        </div>
        <p className="workbench-person-note">{character.profile}</p>
        <h5 className="workbench-kicker workbench-reason-label">
          {copy.connections}
        </h5>
        <ul className="workbench-graph-connections">
          {connections.map((edge) => (
            <li key={`${edge.source}-${edge.target}`} data-tone={edge.tone}>
              <p>
                <span>{personName(edge.source)}</span>
                <ArrowRight size={12} aria-hidden="true" />
                <strong>{edge.relation}</strong>
                <ArrowRight size={12} aria-hidden="true" />
                <span>{personName(edge.target)}</span>
              </p>
              <p>{edge.fact}</p>
            </li>
          ))}
        </ul>
        <div className="workbench-player-affinity">
          <p className="workbench-kicker">{copy.affinityTitle}</p>
          {character.score === null ? (
            <p className="workbench-person-note">{copy.unknownAffinity}</p>
          ) : (
            <>
              <div className="workbench-affinity-heading">
                <span>{character.connection}</span>
                <span className="workbench-score">+{character.score}</span>
              </div>
              <meter
                className="workbench-affinity-meter"
                min={-100}
                max={100}
                value={character.score}
                aria-label={copy.affinity}
              >
                {character.score}
              </meter>
              <p className="workbench-meta">{copy.range}</p>
              <p className="workbench-person-note">{character.note}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
