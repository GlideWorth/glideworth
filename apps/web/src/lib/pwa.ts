/**
 * Installable PWA: registers the offline-shell service worker in production builds and offers a
 * reload when a new version of Glideworth has been deployed.
 */
import { toast } from "../components/ui/toaster";

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        const offer = (worker: ServiceWorker) =>
          toast({
            title: "A new version of Glideworth is ready",
            description: "Reload to use it. Your data is not affected.",
            duration: 0,
            action: { label: "Reload", onClick: () => worker.postMessage("skip-waiting") },
          });
        if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
        reg.addEventListener("updatefound", () => {
          const w = reg.installing;
          w?.addEventListener("statechange", () => {
            if (w.state === "installed" && navigator.serviceWorker.controller) offer(w);
          });
        });
        // The first install claims a page that had no worker: that is not a new version, and reloading
        // then would restart the page a few seconds into a first visit (and clear a half-filled form).
        let controlled = !!navigator.serviceWorker.controller;
        let reloading = false;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          if (!controlled) {
            controlled = true;
            return;
          }
          if (reloading) return;
          reloading = true;
          window.location.reload();
        });
      })
      .catch(() => {
        /* offline shell is optional */
      });
  });
}
