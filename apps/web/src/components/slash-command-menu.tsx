import type { CommandSummary } from "../types.js";

export function SlashCommandMenu(input: {
  label: string;
  commands: CommandSummary[];
  selectedIndex: number;
  onSelect(command: CommandSummary): void;
}) {
  return (
    <div className="slash-menu" role="listbox" aria-label={input.label}>
      {input.commands.map((command, index) => (
        <button
          key={command.name}
          type="button"
          role="option"
          aria-selected={index === input.selectedIndex}
          className={index === input.selectedIndex ? "slash-menu-item active" : "slash-menu-item"}
          onMouseDown={(event) => {
            event.preventDefault();
            input.onSelect(command);
          }}
        >
          <div className="slash-menu-head">
            <span className="slash-menu-command">/{command.name}</span>
            <span className="slash-menu-usage">{command.usage}</span>
          </div>
          <div className="slash-menu-description">{command.description}</div>
          {command.positionalHints?.length || command.flagHints?.length ? (
            <div className="slash-menu-hints">
              {(command.positionalHints ?? []).map((hint) => (
                <span key={`pos:${command.name}:${hint}`} className="slash-menu-chip">{hint}</span>
              ))}
              {(command.flagHints ?? []).map((flag) => (
                <span key={`flag:${command.name}:${flag.name}`} className="slash-menu-chip">{flag.name}</span>
              ))}
            </div>
          ) : null}
        </button>
      ))}
    </div>
  );
}
