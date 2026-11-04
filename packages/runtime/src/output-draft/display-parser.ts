/**
 * Reads display units out of a JSON document while it is still being
 * written: the arguments of a `submit-output` call as the model streams them.
 *
 * A display declaration names where the player-visible text lives (`units`,
 * a JSON pointer to an array of unit objects, an array of strings, or one
 * string), the text field inside each unit object, and the metadata fields
 * sent along with it. The parser is a single pass over the characters, so a
 * fragment costs only its own length however long the document grows.
 *
 * It never decides validity: a document it cannot read simply stops
 * producing units, and the host validates the finished call as always.
 */

import type {
  DisplayMetaValue,
  DisplayUnit,
  OutputDisplaySpec,
} from "@covel/shared/plugin-runtime";

export type { DisplayUnit, OutputDisplaySpec };

type PathPart = string | number;

interface Frame {
  readonly kind: "object" | "array";
  key: string | undefined;
  index: number;
  /** What the next significant character must be. */
  expect: "key" | "colon" | "value" | "comma";
}

interface UnitState {
  text: string;
  meta: Record<string, DisplayMetaValue>;
  complete: boolean;
  /** Whether the element has displayed text; others are skipped, as in displayUnitsOf. */
  hasText: boolean;
}

/** Split a JSON pointer into its reference tokens. */
export function parseJsonPointer(pointer: string): readonly string[] {
  if (!pointer.startsWith("/"))
    throw new Error(`invalid JSON pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

export class DisplayStreamParser {
  private readonly unitsPath: readonly string[];
  private frames: Frame[] = [];
  private units = new Map<number, UnitState>();
  // Finished units never change, so the list of them only grows.
  private done: DisplayUnit[] = [];
  private scanned = 0;
  private generation = 0;
  private rootDone = false;
  private failedAt: number | undefined;
  private consumed = 0;
  // String being read.
  private inString = false;
  private stringIsKey = false;
  private stringTarget: { unit: number; field: string } | undefined;
  private stringBuffer = "";
  private escape: "none" | "backslash" | "unicode" = "none";
  private unicode = "";
  // Number or literal being read.
  private literal: string | undefined;
  private literalTarget: { unit: number; field: string } | undefined;

  constructor(private readonly spec: OutputDisplaySpec) {
    this.unitsPath = parseJsonPointer(spec.units);
  }

  /**
   * Changes exactly when {@link completeUnits} does, so a caller can tell
   * without comparing the units themselves.
   */
  get completeRevision(): string {
    this.completeUnits();
    return `${this.generation}:${this.done.length}`;
  }

  /** True once the text stopped being readable JSON. */
  get failed(): boolean {
    return this.failedAt !== undefined;
  }

  push(fragment: string): void {
    for (const char of fragment) {
      if (this.failedAt !== undefined) return;
      this.consumed++;
      this.step(char);
    }
  }

  /** Start over from a complete replacement document. */
  replace(document: string): void {
    this.frames = [];
    this.units = new Map();
    this.done = [];
    this.scanned = 0;
    this.generation++;
    this.rootDone = false;
    this.failedAt = undefined;
    this.consumed = 0;
    this.inString = false;
    this.stringTarget = undefined;
    this.stringBuffer = "";
    this.escape = "none";
    this.literal = undefined;
    this.literalTarget = undefined;
    this.push(document);
  }

  /**
   * Units whose text is final, in order, stopping at the first element still
   * being written. Elements without displayed text are skipped.
   */
  completeUnits(): readonly DisplayUnit[] {
    for (;;) {
      const unit = this.units.get(this.scanned);
      if (!unit?.complete) return this.done;
      if (unit.hasText) this.done.push(toUnit(unit));
      this.scanned++;
    }
  }

  /** The unit being written after the complete ones, with its text so far. */
  partialUnit(): DisplayUnit | undefined {
    this.completeUnits();
    const index = this.scanned;
    const unit = this.units.get(index);
    if (!unit || unit.complete) return undefined;
    // A pending high surrogate is half a character.
    const text =
      this.stringTarget?.unit === index && this.stringTarget.field === "text"
        ? trimLoneSurrogate(this.stringBuffer)
        : unit.text;
    return text ? toUnit({ ...unit, text }) : undefined;
  }

  private fail(): void {
    this.failedAt = this.consumed;
  }

  private path(): PathPart[] {
    return this.frames.map((frame) =>
      frame.kind === "object" ? (frame.key ?? "") : frame.index,
    );
  }

  /** Where a value starting now at `path` lands, if it is displayed. */
  private targetOf(
    path: readonly PathPart[],
    kind: "string" | "primitive",
  ): { unit: number; field: string } | undefined {
    const base = this.unitsPath;
    if (!base.every((part, index) => path[index] === part)) return undefined;
    const rest = path.slice(base.length);
    if (rest.length === 0)
      return kind === "string" ? { unit: 0, field: "text" } : undefined;
    const [index, field] = rest;
    if (typeof index !== "number") return undefined;
    if (rest.length === 1)
      return this.spec.text === undefined && kind === "string"
        ? { unit: index, field: "text" }
        : undefined;
    if (rest.length !== 2 || typeof field !== "string") return undefined;
    if (field === this.spec.text && kind === "string")
      return { unit: index, field: "text" };
    if (this.spec.meta?.includes(field)) return { unit: index, field };
    return undefined;
  }

  private unit(index: number): UnitState {
    let unit = this.units.get(index);
    if (!unit) {
      unit = { text: "", meta: {}, complete: false, hasText: false };
      this.units.set(index, unit);
    }
    return unit;
  }

  private assign(
    target: { unit: number; field: string },
    value: DisplayMetaValue,
  ): void {
    const unit = this.unit(target.unit);
    if (target.field === "text") {
      if (typeof value === "string") {
        unit.text = value;
        // A lone string unit shows nothing when empty, as in displayUnitsOf.
        const lone = this.path().length === this.unitsPath.length;
        unit.hasText = !lone || value !== "";
      }
    } else unit.meta[target.field] = value;
  }

  /** A value at the current position is starting; returns its path. */
  private beginValue(): PathPart[] | undefined {
    const top = this.frames.at(-1);
    if (!top) {
      if (this.rootDone) return undefined;
      return [];
    }
    if (top.expect !== "value") return undefined;
    return this.path();
  }

  /** The value at the top position finished. */
  private endValue(path: readonly PathPart[]): void {
    const top = this.frames.at(-1);
    if (!top) {
      this.rootDone = true;
      return;
    }
    top.expect = "comma";
    // A whole unit object (or string unit) is complete.
    const base = this.unitsPath;
    if (
      path.length === base.length + 1 &&
      typeof path[base.length] === "number" &&
      base.every((part, index) => path[index] === part)
    ) {
      this.unit(path[base.length] as number).complete = true;
    }
  }

  private step(char: string): void {
    if (this.inString) return this.stringChar(char);
    if (this.literal !== undefined) {
      if (/[0-9a-zA-Z.+-]/.test(char)) {
        this.literal += char;
        return;
      }
      this.finishLiteral();
      if (this.failedAt !== undefined) return;
    }
    if (char === " " || char === "\n" || char === "\r" || char === "\t") return;
    const top = this.frames.at(-1);
    switch (char) {
      case "{":
      case "[": {
        const path = this.beginValue();
        if (!path) return this.fail();
        this.frames.push({
          kind: char === "{" ? "object" : "array",
          key: undefined,
          index: 0,
          expect: char === "{" ? "key" : "value",
        });
        return;
      }
      case "}":
      case "]": {
        const kind = char === "}" ? "object" : "array";
        if (
          !top ||
          top.kind !== kind ||
          (top.expect !== "comma" &&
            !(
              top.expect === (kind === "object" ? "key" : "value") &&
              (kind === "object" ? top.key === undefined : top.index === 0)
            ))
        )
          return this.fail();
        this.frames.pop();
        const path = this.path();
        // The container itself was the value at the parent's position.
        this.endValue(path);
        return;
      }
      case ":":
        if (top?.kind !== "object" || top.expect !== "colon")
          return this.fail();
        top.expect = "value";
        return;
      case ",":
        if (!top || top.expect !== "comma") return this.fail();
        if (top.kind === "object") top.expect = "key";
        else {
          top.index++;
          top.expect = "value";
        }
        return;
      case '"': {
        if (top?.kind === "object" && top.expect === "key") {
          this.inString = true;
          this.stringIsKey = true;
          this.stringTarget = undefined;
          this.stringBuffer = "";
          return;
        }
        const path = this.beginValue();
        if (!path) return this.fail();
        this.inString = true;
        this.stringIsKey = false;
        this.stringTarget = this.targetOf(path, "string");
        if (this.stringTarget) this.unit(this.stringTarget.unit);
        this.stringBuffer = "";
        return;
      }
      default: {
        const path = this.beginValue();
        if (!path || !/[-0-9tfn]/.test(char)) return this.fail();
        this.literal = char;
        this.literalTarget = this.targetOf(path, "primitive");
      }
    }
  }

  private stringChar(char: string): void {
    if (this.escape === "unicode") {
      this.unicode += char;
      if (this.unicode.length < 4) return;
      if (!/^[0-9a-fA-F]{4}$/.test(this.unicode)) return this.fail();
      this.appendString(String.fromCharCode(Number.parseInt(this.unicode, 16)));
      this.escape = "none";
      return;
    }
    if (this.escape === "backslash") {
      if (char === "u") {
        this.escape = "unicode";
        this.unicode = "";
        return;
      }
      const decoded = ESCAPES[char];
      if (decoded === undefined) return this.fail();
      this.appendString(decoded);
      this.escape = "none";
      return;
    }
    if (char === "\\") {
      this.escape = "backslash";
      return;
    }
    if (char !== '"') {
      this.appendString(char);
      return;
    }
    this.inString = false;
    const value = this.stringBuffer;
    const top = this.frames.at(-1);
    if (this.stringIsKey) {
      if (!top) return this.fail();
      top.key = value;
      top.expect = "colon";
      return;
    }
    const path = this.path();
    if (this.stringTarget) this.assign(this.stringTarget, value);
    const target = this.stringTarget;
    this.stringTarget = undefined;
    this.endValue(path);
    // A single string unit, or a string element of a unit array, is whole.
    if (
      target &&
      target.field === "text" &&
      path.length <= this.unitsPath.length + 1
    )
      this.unit(target.unit).complete = true;
  }

  private appendString(text: string): void {
    // Only keys and displayed strings are kept; other text is skipped.
    if (this.stringIsKey || this.stringTarget) this.stringBuffer += text;
  }

  private finishLiteral(): void {
    const raw = this.literal!;
    this.literal = undefined;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return this.fail();
    }
    const path = this.path();
    if (
      this.literalTarget &&
      (typeof value === "number" || typeof value === "boolean")
    )
      this.assign(this.literalTarget, value);
    this.literalTarget = undefined;
    this.endValue(path);
  }
}

function toUnit(unit: UnitState): DisplayUnit {
  return Object.keys(unit.meta).length > 0
    ? { text: unit.text, meta: { ...unit.meta } }
    : { text: unit.text };
}

function trimLoneSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

/** The display units of a complete, parsed value. */
export function displayUnitsOf(
  value: unknown,
  spec: OutputDisplaySpec,
): readonly DisplayUnit[] {
  let node: unknown = value;
  for (const part of parseJsonPointer(spec.units)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return [];
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node === "string") return node ? [{ text: node }] : [];
  if (!Array.isArray(node)) return [];
  const units: DisplayUnit[] = [];
  for (const element of node) {
    if (spec.text === undefined) {
      if (typeof element === "string") units.push({ text: element });
      continue;
    }
    if (!element || typeof element !== "object" || Array.isArray(element))
      continue;
    const record = element as Record<string, unknown>;
    const text = record[spec.text];
    if (typeof text !== "string") continue;
    const meta: Record<string, DisplayMetaValue> = {};
    for (const field of spec.meta ?? []) {
      const entry = record[field];
      if (
        typeof entry === "string" ||
        typeof entry === "number" ||
        typeof entry === "boolean"
      )
        meta[field] = entry;
    }
    units.push(Object.keys(meta).length > 0 ? { text, meta } : { text });
  }
  return units;
}
