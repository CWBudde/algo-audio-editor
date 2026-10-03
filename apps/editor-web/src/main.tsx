import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { initializeExtractionWindow } from "./lib/extraction-window";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

void initializeExtractionWindow().then(
  () =>
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  (error: unknown) => {
    root.textContent = error instanceof Error ? error.message : "Could not open extracted channel.";
  },
);
