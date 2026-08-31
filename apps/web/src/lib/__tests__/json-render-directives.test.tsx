import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { nestedToFlat } from "@json-render/core";
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
