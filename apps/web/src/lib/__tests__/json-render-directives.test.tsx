import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  nestedToFlat,
  createDirectiveRegistry,
  resolvePropValue,
} from "@json-render/core";
import {
  JSONUIProvider,
  Renderer,
  type ComponentRenderer,
} from "@json-render/react";
import { covelDirectives } from "../json-render-directives.js";

afterEach(cleanup);

const Probe: ComponentRenderer = ({ element, emit }) => (
  <button type="button" onClick={() => emit("click")}>
    {String(element.props?.value)}
  </button>
);

const registry = { Probe };

describe("covel json-render directives", () => {
  it("resolves standard directives in component props", () => {
    const spec = nestedToFlat({
      type: "Probe",
      props: {
        value: {
          $concat: ["Total: ", { $math: "add", a: { $state: "/base" }, b: 2 }],
        },
      },
    });

    render(
      <JSONUIProvider
        registry={registry}
        initialState={{ base: 4 }}
        handlers={{}}
        directives={covelDirectives}
      >
        <Renderer spec={spec} registry={registry} />
      </JSONUIProvider>,
    );

    expect(screen.getByRole("button", { name: "Total: 6" })).toBeTruthy();
  });

  it("resolves the same directives in action params", () => {
    const handleRun = vi.fn();
    const spec = nestedToFlat({
      type: "Probe",
      props: { value: "Run" },
      on: {
        click: {
          action: "run",
          params: {
            count: { $count: { $state: "/items" } },
            label: { $concat: ["item-", { $state: "/name" }] },
          },
        },
      },
    });

    render(
      <JSONUIProvider
        registry={registry}
        initialState={{ items: [1, 2, 3], name: "dice" }}
        handlers={{ run: handleRun }}
        directives={covelDirectives}
      >
        <Renderer spec={spec} registry={registry} />
      </JSONUIProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(handleRun).toHaveBeenCalledWith({ count: 3, label: "item-dice" });
  });
});

describe("$map", () => {
  const ctx = {
    stateModel: { status: "active" },
    directives: createDirectiveRegistry(covelDirectives),
  };
  it("returns translatable labels and resolves dynamic fallbacks", () => {
    expect(
      resolvePropValue(
        {
          $map: { $state: "/status" },
          labels: { active: { en: "Active", zh: "进行中" } },
        },
        ctx,
      ),
    ).toEqual({ en: "Active", zh: "进行中" });
    expect(
      resolvePropValue(
        {
          $map: "missing",
          labels: {},
          fallback: { $concat: ["Unknown: ", { $state: "/status" }] },
        },
        ctx,
      ),
    ).toBe("Unknown: active");
    expect(resolvePropValue({ $map: "missing", labels: {} }, ctx)).toBe(
      "missing",
    );
    expect(
      resolvePropValue({ $map: "missing", labels: {}, fallback: null }, ctx),
    ).toBeNull();
  });
  it("matches primitive keys and empty labels, with own-property lookup only", () => {
    for (const value of [0, false, ""])
      expect(
        resolvePropValue({ $map: value, labels: { [String(value)]: "" } }, ctx),
      ).toBe("");
    for (const value of ["constructor", "toString", "__proto__"])
      expect(
        resolvePropValue({ $map: value, labels: {}, fallback: "Unknown" }, ctx),
      ).toBe("Unknown");
    expect(
      resolvePropValue(
        { $map: "constructor", labels: { constructor: "Own label" } },
        ctx,
      ),
    ).toBe("Own label");
  });
  it("does not throw for a malformed directive from an unvalidated surface", () => {
    expect(
      resolvePropValue({ $map: "active", labels: null }, ctx),
    ).toBeUndefined();
  });
  it("resolves in action params with the same fallback semantics", () => {
    const select = vi.fn();
    render(
      <JSONUIProvider
        registry={registry}
        handlers={{ select }}
        directives={covelDirectives}
      >
        <Renderer
          registry={registry}
          spec={nestedToFlat({
            type: "Probe",
            props: { value: "Select" },
            on: {
              click: {
                action: "select",
                params: {
                  label: { $map: "missing", labels: {}, fallback: "Unknown" },
                },
              },
            },
          })}
        />
      </JSONUIProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(select).toHaveBeenCalledWith({ label: "Unknown" });
  });
});
