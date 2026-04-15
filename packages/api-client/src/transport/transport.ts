export interface RequestInit {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface SseEvent {
  type: string;
  data: unknown;
  id?: string;
  retry?: number;
}

export interface Transport {
  request<T>(init: RequestInit): Promise<T>;
  stream(init: RequestInit): AsyncIterable<SseEvent>;
}
