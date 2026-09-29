import type {
  LLMCitation,
  LLMDiagnostics,
  LLMProviderWarning,
  LLMRefusal,
  LLMSource,
} from "@covel/shared";
import { AiProviderError } from "../errors.js";

type Protocol = "chat" | "responses" | "anthropic";
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function index(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Normalize only recognized public fields, never arbitrary response metadata. */
export class ResponseDiagnostics {
  private readonly warnings = new Map<string, LLMProviderWarning>();
  private readonly sources = new Map<string, LLMSource>();
  private readonly citations = new Map<string, LLMCitation>();
  private readonly refusals = new Map<string, string>();
  private refusalReason?: LLMRefusal["reason"];
  private anthropicText = "";

  constructor(private readonly protocol: Protocol) {}

  push(payload: Record<string, unknown>): void {
    this.readWarnings(payload.warnings);
    const error = record(payload.error);
    this.readFinishReason(error.code ?? error.type);
    if (this.refusalReason && typeof error.message === "string") {
      this.refusals.set("error", error.message);
    }
    if (this.protocol === "chat") this.readChat(payload);
    if (this.protocol === "responses") this.readResponses(payload);
    if (this.protocol === "anthropic") this.readAnthropic(payload);
  }

  diagnostics(): LLMDiagnostics | undefined {
    const message = [...this.refusals.values()].filter(Boolean).join("\n\n");
    const diagnostics: LLMDiagnostics = {
      ...(this.warnings.size ? { warnings: [...this.warnings.values()] } : {}),
      ...(this.sources.size ? { sources: [...this.sources.values()] } : {}),
      ...(this.citations.size
        ? { citations: [...this.citations.values()] }
        : {}),
      ...(this.refusalReason
        ? {
            refusal: {
              reason: this.refusalReason,
              ...(message ? { message } : {}),
            },
          }
        : {}),
    };
    return Object.keys(diagnostics).length ? diagnostics : undefined;
  }

  /** Mixed text/tool output does not turn a provider refusal into success. */
  assertNotRefused(provider: string): void {
    const diagnostics = this.diagnostics();
    if (!diagnostics?.refusal) return;
    throw new AiProviderError({
      code: "REFUSAL",
      message: `${provider} refused the generation`,
      provider,
      retriable: false,
      details: { diagnostics },
    });
  }

  private readWarnings(value: unknown): void {
    for (const raw of array(value)) {
      const warning = record(raw);
      const message = text(warning.message) ?? text(raw);
      if (!message) continue;
      const type =
        warning.type === "unsupported" || warning.type === "compatibility"
          ? warning.type
          : "other";
      const normalized: LLMProviderWarning = {
        type,
        message,
        ...(typeof warning.feature === "string"
          ? { feature: warning.feature }
          : {}),
      };
      this.warnings.set(JSON.stringify(normalized), normalized);
    }
  }

  private readFinishReason(value: unknown): void {
    if (value === "content_filter") this.refusalReason = "content-filter";
    else if (value === "refusal" && !this.refusalReason)
      this.refusalReason = "refusal";
  }

  private refusal(value: unknown, key: string, append = false): void {
    if (typeof value !== "string") return;
    this.refusalReason ??= "refusal";
    this.refusals.set(
      key,
      append ? (this.refusals.get(key) ?? "") + value : value,
    );
  }

  private citation(raw: unknown): void {
    const annotation = record(raw);
    const citation =
      annotation.type === "url_citation" && annotation.url_citation
        ? record(annotation.url_citation)
        : annotation;
    let source: LLMSource | undefined;
    const url = text(citation.url);
    if (
      url &&
      [
        "url_citation",
        "web_search_result_location",
        "search_result_location",
      ].includes(String(annotation.type))
    ) {
      source = {
        type: "url",
        id: `url:${url}`,
        url,
        ...(typeof citation.title === "string"
          ? { title: citation.title }
          : {}),
      };
    } else if (
      [
        "file_citation",
        "container_file_citation",
        "file_path",
        "page_location",
        "char_location",
        "content_block_location",
      ].includes(String(annotation.type))
    ) {
      const fileId = text(citation.file_id);
      const documentIndex = index(citation.document_index);
      if (!fileId && documentIndex === undefined) return;
      const containerId = text(citation.container_id);
      const title = text(citation.document_title) ?? text(citation.filename);
      source = {
        type: "document",
        id: fileId
          ? `file:${containerId ? `${containerId}:` : ""}${fileId}`
          : `document:${documentIndex}`,
        ...(title ? { title } : {}),
        ...(typeof citation.filename === "string"
          ? { fileName: citation.filename }
          : {}),
        ...(documentIndex !== undefined ? { documentIndex } : {}),
      };
    }
    if (!source) return;
    this.sources.set(source.id, { ...this.sources.get(source.id), ...source });
    const normalized: LLMCitation = {
      sourceId: source.id,
      ...(annotation.type === "url_citation"
        ? { location: "response" as const }
        : {}),
      ...([
        "page_location",
        "char_location",
        "content_block_location",
        "web_search_result_location",
        "search_result_location",
      ].includes(String(annotation.type))
        ? { location: "source" as const }
        : {}),
      ...(typeof citation.cited_text === "string"
        ? { citedText: citation.cited_text }
        : {}),
      ...this.citationOffsets(citation),
    };
    this.citations.set(JSON.stringify(normalized), normalized);
  }

  private citationOffsets(
    citation: Record<string, unknown>,
  ): Partial<LLMCitation> {
    const offsets: Record<string, number> = {};
    for (const [wire, canonical] of [
      ["start_index", "startIndex"],
      ["end_index", "endIndex"],
      ["start_char_index", "startIndex"],
      ["end_char_index", "endIndex"],
      ["start_page_number", "startPage"],
      ["end_page_number", "endPage"],
      ["start_block_index", "startBlockIndex"],
      ["end_block_index", "endBlockIndex"],
    ] as const) {
      const value = index(citation[wire]);
      if (value !== undefined) offsets[canonical] = value;
    }
    return offsets;
  }

  private readChat(payload: Record<string, unknown>): void {
    const choice = record(array(payload.choices)[0]);
    const message = record(choice.message);
    const delta = record(choice.delta);
    this.readFinishReason(choice.finish_reason);
    this.refusal(message.refusal, "chat");
    this.refusal(delta.refusal, "chat", true);
    for (const annotation of [
      ...array(message.annotations),
      ...array(delta.annotations),
    ])
      this.citation(annotation);
  }

  private responseItem(raw: unknown, outputIndex: number): void {
    const item = record(raw);
    for (const [contentIndex, rawPart] of array(item.content).entries()) {
      const part = record(rawPart);
      if (part.type === "refusal")
        this.refusal(part.refusal ?? "", `${outputIndex}:${contentIndex}`);
      for (const annotation of array(part.annotations))
        this.citation(annotation);
    }
  }

  private readResponses(payload: Record<string, unknown>): void {
    const response = payload.response ? record(payload.response) : payload;
    this.readWarnings(response.warnings);
    const error = record(response.error);
    this.readFinishReason(error.code ?? error.type);
    if (this.refusalReason && typeof error.message === "string") {
      this.refusals.set("error", error.message);
    }
    this.readFinishReason(record(response.incomplete_details).reason);
    for (const [outputIndex, item] of array(response.output).entries())
      this.responseItem(item, outputIndex);
    if (payload.type === "response.output_item.done")
      this.responseItem(payload.item, index(payload.output_index) ?? 0);
    if (payload.type === "response.output_text.annotation.added")
      this.citation(payload.annotation);
    if (
      payload.type === "response.refusal.delta" ||
      payload.type === "response.refusal.done"
    ) {
      this.refusal(
        payload.type === "response.refusal.delta"
          ? payload.delta
          : payload.refusal,
        `${index(payload.output_index) ?? 0}:${index(payload.content_index) ?? 0}`,
        payload.type === "response.refusal.delta",
      );
    }
  }

  private readAnthropic(payload: Record<string, unknown>): void {
    const message =
      payload.type === "message_start" ? record(payload.message) : payload;
    this.readWarnings(message.warnings);
    this.readFinishReason(message.stop_reason);
    const blocks = array(message.content).map(record);
    if (blocks.length)
      this.anthropicText = blocks
        .map((block) => text(block.text) ?? "")
        .join("");
    for (const block of blocks)
      for (const citation of array(block.citations)) this.citation(citation);
    if (payload.type === "content_block_start") {
      const block = record(payload.content_block);
      if (block.type === "text") this.anthropicText += text(block.text) ?? "";
      for (const citation of array(block.citations)) this.citation(citation);
    }
    const delta = record(payload.delta);
    if (payload.type === "content_block_delta") {
      if (delta.type === "citations_delta") this.citation(delta.citation);
      if (delta.type === "text_delta")
        this.anthropicText += text(delta.text) ?? "";
    }
    if (payload.type === "message_delta")
      this.readFinishReason(delta.stop_reason);
    if (this.refusalReason && this.anthropicText)
      this.refusals.set("anthropic", this.anthropicText);
  }
}

export function readResponseDiagnostics(
  payload: Record<string, unknown>,
  protocol: Protocol,
  provider: string,
): LLMDiagnostics | undefined {
  const diagnostics = new ResponseDiagnostics(protocol);
  diagnostics.push(payload);
  diagnostics.assertNotRefused(provider);
  return diagnostics.diagnostics();
}
