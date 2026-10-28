// @vitest-environment node
import { describe, expect, it } from "vitest";
import { sharedServerEndpointNote } from "../local-network-url.js";

describe("sharedServerEndpointNote", () => {
  it.each([
    ["http://127.0.0.1:3425/v1", "relay"],
    ["http://localhost:11434", "relay"],
    ["https://192.168.1.20/v1", "relay"],
    ["https://gateway.local/v1", "relay"],
    ["http://192.168.1.20:8000/v1", "lan-http"],
    ["http://gateway.local/v1", "lan-http"],
    ["http://api.example.com/v1", "needs-https"],
  ] as const)("notes %s as %s", (url, note) => {
    expect(sharedServerEndpointNote(url, true)).toBe(note);
  });

  it.each(["https://api.openai.com/v1", "", "not a url", undefined])(
    "says nothing about %s",
    (url) => {
      expect(sharedServerEndpointNote(url, true)).toBeUndefined();
    },
  );

  it("asks for a public HTTPS endpoint where the server offers no relay", () => {
    expect(sharedServerEndpointNote("http://127.0.0.1:3425/v1", false)).toBe(
      "needs-https",
    );
  });
});
