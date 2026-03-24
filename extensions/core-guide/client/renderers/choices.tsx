interface ChoicesRendererProps {
  data?: {
    title?: string;
    options?: Array<{
      id: string;
      label: string;
    }>;
  };
}

// Placeholder renderer that keeps the manifest honest until the Web Host
// starts loading package-owned renderers dynamically.
export default function ChoicesRenderer({ data }: ChoicesRendererProps) {
  return (
    <section data-package-renderer="core-guide/choices">
      <h3>{data?.title ?? "Choices"}</h3>
      <ul>
        {(data?.options ?? []).map((option) => (
          <li key={option.id}>{option.label}</li>
        ))}
      </ul>
    </section>
  );
}
