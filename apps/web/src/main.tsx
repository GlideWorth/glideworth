// First: moves pre-rename browser storage keys before any store reads them.
import "./lib/legacy-storage";
// Then: on a /demo page, refuse the server's paths before any other module can request them.
import "./lib/demo";
import "@fontsource-variable/inter";
import "@fontsource-variable/fraunces";
import "./styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerServiceWorker } from "./lib/pwa";
import { router } from "./router";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

registerServiceWorker();
