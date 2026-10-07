export interface SimpleCompletionAdapter<
  Role extends "user" | "assistant" = "user" | "assistant",
> {
  complete(params: {
    systemPrompt: string;
    messages: readonly { role: Role; content: string }[];
    model?: string;
  }): Promise<{ content: string }>;
}
