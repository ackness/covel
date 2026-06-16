import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";

interface PluginFilterBarProps {
  pluginSearch: string;
  onPluginSearchChange: (value: string) => void;
  availablePluginTags: string[];
  activePluginTags: ReadonlySet<string>;
  onTogglePluginTag: (tag: string) => void;
}

export function PluginFilterBar({
  pluginSearch,
  onPluginSearchChange,
  availablePluginTags,
  activePluginTags,
  onTogglePluginTag,
}: PluginFilterBarProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-2 mb-3">
      <div className="flex items-center gap-2 border border-border bg-background px-2 py-1.5">
        <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <input
          value={pluginSearch}
          onChange={(event) => onPluginSearchChange(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          placeholder={t(
            "session.searchPlugins",
            "Search plugins, tags, capabilities",
          )}
        />
      </div>
      {availablePluginTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {availablePluginTags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={`border px-2 py-0.5 text-[10px] transition-colors ${
                activePluginTags.has(tag)
                  ? "border-primary/50 bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => onTogglePluginTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
