import { Languages } from "lucide-react";
import type { Copy } from "../copy.js";

/** Language support belongs to every play style, not to the carousel's packs. */
export function LanguageFeature({ copy }: { copy: Copy }) {
  const feature = copy.preview.languages;
  return (
    <article
      className="language-feature preview-languages mt-5 rounded-3xl border border-line bg-raised"
      aria-labelledby="language-feature-title"
    >
      <div>
        <p className="preview-label">
          <Languages size={14} aria-hidden />
          {feature.edition}
        </p>
        <h3 id="language-feature-title">{feature.title}</h3>
        <p className="text-muted">{feature.body}</p>
      </div>
      <ul>
        {feature.voices.map((voice) => (
          <li key={voice.tag} lang={voice.tag}>
            <span className="preview-label">{voice.name}</span>
            <p>{voice.text}</p>
          </li>
        ))}
      </ul>
    </article>
  );
}
