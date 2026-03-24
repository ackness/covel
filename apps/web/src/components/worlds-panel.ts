import React, { createElement, useEffect, useState } from "react";

type WorldRecord = {
  id: string;
  name: string;
  description: string;
};

export function WorldsPanel(input: {
  runtimeBaseUrl: string;
  onOpenWorld?(worldId: string): void;
}) {
  const [worlds, setWorlds] = useState<WorldRecord[]>([]);
  const [worldName, setWorldName] = useState("");
  const [worldDescription, setWorldDescription] = useState("");

  useEffect(() => {
    void fetchWorlds();
  }, []);

  async function fetchWorlds() {
    const response = await fetch(`${input.runtimeBaseUrl}/worlds`);
    const payload = await response.json() as WorldRecord[];
    setWorlds(payload);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch(`${input.runtimeBaseUrl}/worlds`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: worldName,
        description: worldDescription
      })
    });
    const createdWorld = await response.json() as WorldRecord;
    setWorlds((current) => [...current, createdWorld]);
    setWorldName("");
    setWorldDescription("");
  }

  return createElement(
    "section",
    { className: "panel-section" },
    createElement("div", { className: "eyebrow" }, "Worlds"),
    createElement(
      "ul",
      { className: "stack-list" },
      ...worlds.map((world) =>
        createElement(
          "li",
          { key: world.id },
          createElement(
            "button",
            {
              className: "list-button",
              type: "button",
              onClick: () => input.onOpenWorld?.(world.id),
              "aria-label": `Open ${world.name}`
            },
            world.name
          )
        )
      )
    ),
    createElement(
      "form",
      { className: "form-stack", onSubmit: handleSubmit },
      createElement(
        "label",
        { className: "field" },
        createElement("span", null, "World name"),
        createElement("input", {
          "aria-label": "World name",
          value: worldName,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setWorldName(event.target.value)
        })
      ),
      createElement(
        "label",
        { className: "field" },
        createElement("span", null, "World description"),
        createElement("textarea", {
          "aria-label": "World description",
          value: worldDescription,
          onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
            setWorldDescription(event.target.value)
        })
      ),
      createElement(
        "button",
        {
          className: "primary-button",
          type: "submit"
        },
        "Create world"
      )
    )
  );
}
