import { describe, expect, it } from "vitest";
import { parseImportedThemeFile } from "../validate.js";

describe("parseImportedThemeFile", () => {
	it("parses css themes by extracting the data-theme id", () => {
		const payload = parseImportedThemeFile(
			`
      html[data-theme="cinder"] {
        --color-background: #10141c;
      }

      html[data-theme="cinder"].dark {
        --color-background: #090b10;
      }
      `,
			"cinder.css",
		);

		expect(payload.theme.id).toBe("cinder");
		expect(payload.theme.source).toBe("custom");
		expect(payload.theme.schemes).toEqual(["light", "dark"]);
	});

	it("parses json theme packages", () => {
		const payload = parseImportedThemeFile(
			JSON.stringify({
				id: "sunfall",
				label: {
					"zh-CN": "落日",
					"en-US": "Sunfall",
				},
				schemes: ["light"],
				cssText: 'html[data-theme="sunfall"] { --color-background: #f7e8d5; }',
			}),
			"sunfall.theme.json",
		);

		expect(payload.theme.id).toBe("sunfall");
		expect(payload.theme.schemes).toEqual(["light"]);
		expect(payload.theme.cssText).toContain('data-theme="sunfall"');
	});

	it("rejects css without a theme selector", () => {
		expect(() =>
			parseImportedThemeFile(".panel { color: red; }", "broken.css"),
		).toThrow(/data-theme/);
	});
});
