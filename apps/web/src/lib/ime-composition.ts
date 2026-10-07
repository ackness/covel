/**
 * Whether a key press belongs to an input method that is still composing.
 *
 * With a Chinese, Japanese or Korean input method, Enter picks a candidate
 * and Escape discards it. A field that also binds those keys (send on Enter,
 * clear on Escape) must leave them alone until the composition ends, or it
 * sends half a sentence or wipes the draft.
 *
 * `isComposing` covers the composition itself. Safari reports the key press
 * that commits a candidate after `compositionend`, with `isComposing` already
 * false; only the legacy key code 229 marks it there.
 */

interface ComposingKeyEvent {
  readonly isComposing: boolean;
  readonly keyCode: number;
}

export function isImeComposing(
  event: ComposingKeyEvent | { readonly nativeEvent: ComposingKeyEvent },
): boolean {
  // A React keyboard event carries the two fields on its native event.
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  return native.isComposing || native.keyCode === 229;
}
