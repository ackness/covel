interface ChoicesRendererProps {
  data?: {
    title?: string;
    options?: Array<{
      id: string;
      label: string;
    }>;
  };
  onChoiceSelect?(optionId: string): void;
}

export default function ChoicesRenderer({ data, onChoiceSelect }: ChoicesRendererProps) {
  return (
    <section data-package-renderer="core-guide/choices">
      <h3>{data?.title ?? "Choices"}</h3>
      <ul className="choice-grid">
        {(data?.options ?? []).map((option) => (
          <li key={option.id}>
            <button
              className="choice-button"
              type="button"
              disabled={!onChoiceSelect}
              onClick={() => onChoiceSelect?.(option.id)}
            >
              {option.label}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
