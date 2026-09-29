/** The speaker contract and the typewriter must use identical boundaries. */
export function splitStageParagraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n\n");
}

export function stageParagraphSpeakerName(
  paragraphSpeakers: readonly (string | null)[] | undefined,
  text: string,
  paragraphIndex: number,
  streamEnded: boolean,
): string | undefined {
  if (!paragraphSpeakers) return undefined;
  const count = splitStageParagraphs(text).length;
  if (
    count > paragraphSpeakers.length ||
    (streamEnded && count !== paragraphSpeakers.length)
  ) {
    return undefined;
  }
  return paragraphSpeakers[paragraphIndex] ?? undefined;
}
