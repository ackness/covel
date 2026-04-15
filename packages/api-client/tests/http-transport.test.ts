import { describe, it, expect, vi } from "vitest";
import { HttpTransport } from "../src/transport/http-transport.js";
import {
  ApiError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  NetworkError,
} from "../src/types/errors.js";

function makeFetch(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    headers: {
      get: (name: string) =>
        ({ "content-type": "application/json", ...headers }[name.toLowerCase()] ?? null),
    },
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

describe("HttpTransport", () => {
  describe("request", () => {
    it("returns parsed JSON on success", async () => {
      const fetch = makeFetch(200, { id: "world-1" });
      const transport = new HttpTransport({ baseUrl: "http://localhost:3001", fetch });

      const result = await transport.request<{ id: string }>({ method: "GET", path: "/api/worlds" });

      expect(result).toEqual({ id: "world-1" });
    });

    it("replaces :param placeholders in the path", async () => {
      const fetch = makeFetch(200, { id: "abc" });
      const transport = new HttpTransport({ baseUrl: "http://localhost:3001", fetch });

      await transport.request({ method: "GET", path: "/api/worlds/:id", params: { id: "abc" } });

      const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain("/api/worlds/abc");
      expect(calledUrl).not.toContain(":id");
    });

    it("appends query parameters", async () => {
      const fetch = makeFetch(200, []);
      const transport = new HttpTransport({ baseUrl: "http://localhost:3001", fetch });

      await transport.request({
        method: "GET",
        path: "/api/events/stream",
        query: { sessionId: "sess-1", active: true },
      });

      const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain("sessionId=sess-1");
      expect(calledUrl).toContain("active=true");
    });

    it("omits undefined query values", async () => {
      const fetch = makeFetch(200, []);
      const transport = new HttpTransport({ baseUrl: "http://localhost:3001", fetch });

      await transport.request({
        method: "GET",
        path: "/api/ui-specs",
        query: { sessionId: undefined },
      });

      const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).not.toContain("sessionId");
    });

    it("throws NotFoundError on 404", async () => {
      const fetch = makeFetch(404, { message: "Not found" });
      const transport = new HttpTransport({ baseUrl: "http://localhost:3001", fetch });

      await expect(
        transport.request({ method: "GET", path: "/api/worlds/:id", params: { id: "nope" } }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws UnauthorizedError on 401", async () => {
      const fetch = makeFetch(401, { message: "Unauthorized" });
      const transport = new HttpTransport({ baseUrl: "http://localhost:3001", fetch });

      await expect(
        transport.request({ method: "GET", path: "/api/sessions" }),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it("throws UnauthorizedError on 403", async () => {
      const fetch = makeFetch(403, { message: "Forbidden" });
      const transport = new HttpTransport({ baseUrl: "http://localhost:3001", fetch });

      await expect(
        transport.request({ method: "GET", path: "/api/sessions" }),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it("throws ValidationError on 422", async () => {
      const fetch = makeFetch(422, { message: "Invalid data" });
      const transport = new HttpTransport({ baseUrl: "http://localhost:3001", fetch });

      await expect(
        transport.request({ method: "POST", path: "/api/sessions", body: {} }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("throws ApiError on 500", async () => {
      const fetch = makeFetch(500, { message: "Internal server error" });
      const transport = new HttpTransport({ baseUrl: "http://localhost:3001", fetch });

      const err = await transport
        .request({ method: "GET", path: "/api/sessions" })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(500);
    });

    it("throws NetworkError when fetch rejects", async () => {
      const fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const transport = new HttpTransport({ baseUrl: "http://localhost:3001", fetch });

      await expect(
        transport.request({ method: "GET", path: "/api/health" }),
      ).rejects.toBeInstanceOf(NetworkError);
    });

    it("includes defaultHeaders in every request", async () => {
      const fetch = makeFetch(200, {});
      const transport = new HttpTransport({
        baseUrl: "http://localhost:3001",
        fetch,
        defaultHeaders: () => ({ "X-Provider-Keys": "abc123" }),
      });

      await transport.request({ method: "GET", path: "/api/health" });

      const calledHeaders = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers as Record<
        string,
        string
      >;
      expect(calledHeaders["X-Provider-Keys"]).toBe("abc123");
    });
  });
});
