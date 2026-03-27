import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { I18nProvider } from "./i18n.js";
import "streamdown/styles.css";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing root element.");
}

createRoot(rootElement).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>
);
