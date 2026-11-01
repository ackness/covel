import { describe, expect, it } from "vitest";
import { entryListPropsSchema } from "../src/schemas/catalog.js";
import { stageCastSchema } from "../src/extension-points/ui-slot.js";
import { pluginUiSpecIssues } from "../src/schemas/ui-spec.js";

describe("declarative inferred departure policy", () => {
  it.each(["fade", "none", undefined])(
    "accepts bounded policy %s and keeps omission optional",
    (exitTransition) => {
      const cast = {
        actors: [],
        retainWhenEmpty: false,
        ...(exitTransition ? { exitTransition } : {}),
      };
      expect(stageCastSchema.parse(cast)).toEqual(cast);
      const props = {
        items: [],
        titleField: "title",
        ...(exitTransition ? { exitTransition } : {}),
      };
      expect(entryListPropsSchema.parse(props)).toMatchObject(props);
      const spec = {
        view: {
          component: "EntryList",
          props: {
            ...props,
            items: { $state: "/records" },
            unrelated: { $state: "/value" },
          },
        },
      };
      expect(pluginUiSpecIssues(spec, "owner")).toEqual([]);
    },
  );

  it.each(["slide-left", "invalid", 300, null, { $state: "/policy" }])(
    "rejects invalid literal %j at its author-facing path",
    (exitTransition) => {
      const cast = stageCastSchema.safeParse({
        actors: [],
        retainWhenEmpty: false,
        exitTransition,
      });
      expect(cast.success).toBe(false);
      if (!cast.success)
        expect(cast.error.issues[0]?.path).toEqual(["exitTransition"]);
      expect(
        entryListPropsSchema.safeParse({
          items: [],
          titleField: "title",
          exitTransition,
        }).success,
      ).toBe(false);
      const spec = {
        view: {
          component: "Stack",
          children: [
            {
              component: "EntryList",
              props: {
                items: { $state: "/records" },
                titleField: "title",
                exitTransition,
              },
            },
          ],
        },
      };
      expect(pluginUiSpecIssues(spec, "owner").map(({ path }) => path)).toEqual(
        ["view.children[0].props.exitTransition"],
      );
    },
  );
});
