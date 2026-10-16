/** Render a form preview exactly as its submitted opening message is rendered. */
export function fillNarrativeTemplate(
  template: string,
  values: Readonly<Record<string, unknown>>,
): string {
  // The key excludes braces and is trimmed after matching: a pattern that also
  // matches the spaces around it backtracks polynomially on an unclosed `{{`.
  return template.replace(
    /\{\{([^{}]+)\}\}([。.]?)/g,
    (_match, key: string, fullStop: string) => {
      const value = values[key.trim()];
      const rendered =
        value !== undefined && value !== null ? String(value) : "";
      // Preserve the submitted text; omit only a duplicate template full stop.
      return fullStop && rendered.endsWith(fullStop)
        ? rendered
        : rendered + fullStop;
    },
  );
}
