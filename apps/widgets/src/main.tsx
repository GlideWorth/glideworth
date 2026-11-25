import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createHost } from "./host";
import "./styles.css";

const root = document.getElementById("root");

if (import.meta.env.DEV && window.parent === window && !window.openai) {
  // `pnpm dev` outside any host: the fixture picker. Removed from the production bundle.
  void import("./dev/preview").then(({ mountPreview }) => {
    if (root) mountPreview(root);
  });
} else if (root) {
  const host = createHost();
  createRoot(root).render(
    <StrictMode>
      <App host={host} />
    </StrictMode>,
  );
}
