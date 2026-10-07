// Test-only entry served directly by Vite; never imported by the application.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import i18n, { i18nReady } from "../../../i18n/index.js";
import { PluginPanel } from "../../../components/session/plugin-panel.js";

await i18nReady;
await i18n.changeLanguage("en-US");

const spec = {
  alwaysRender: true,
  view: {
    component: "Stack",
    children: ["first", "second"].flatMap((key) =>
      ["Input", "Textarea", "Select", "Switch"].map((component) => ({
        component,
        props: {
          label: `${component} ${key}`,
          value: { $bindState: `/${key}/value` },
          checked: { $bindState: `/${key}/checked` },
          options: [
            { value: "initial", label: "Initial" },
            { value: "edited", label: "Edited" },
          ],
        },
      })),
    ),
  },
};

function Fixture() {
  const [locked, setLocked] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setLocked(!locked)}>
        Toggle panel lock
      </button>
      <form
        data-submitted={submitted}
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
        }}
      >
        <PluginPanel
          pluginId="synthetic-owner"
          spec={spec}
          stateOverride={{
            first: { value: "initial", checked: false },
            second: { value: "initial", checked: false },
          }}
          interactionLocked={locked}
        />
      </form>
      <button type="button">After panel</button>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
