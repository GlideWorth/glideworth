/**
 * Explains the two answers any cloud request can get (lib/api-problems.ts): the workspace turned
 * read-only (402) or a daily plan limit is used up (429). Mounted once in the shell. Self-host never
 * produces either, so there it never renders anything.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { describeQuota, onApiProblem } from "../../lib/api-problems";
import { useCloudSession } from "../../lib/auth";
import { toast } from "../ui/toaster";

export function ApiProblemHost() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const owner = useCloudSession()?.workspace?.role === "owner";
  const lastReadOnly = useRef(0);
  useEffect(
    () =>
      onApiProblem((p) => {
        if (p.kind === "quota") {
          toast({
            title: "Daily limit reached",
            description: describeQuota(p, navigator.language),
            tone: "negative",
            duration: 10_000,
          });
          return;
        }
        // The banner and the editors follow the fresh access level.
        void qc.invalidateQueries({ queryKey: ["session"] });
        if (Date.now() - lastReadOnly.current < 10_000) return;
        lastReadOnly.current = Date.now();
        toast({
          title: "This workspace is read-only",
          description: `Your change was not saved and is still on screen. ${
            owner
              ? "Restore editing in Billing, then make the change again."
              : "Ask the workspace owner to restore editing."
          }`,
          tone: "negative",
          duration: 14_000,
          action: {
            label: owner ? "Open billing" : "Details",
            onClick: () =>
              void navigate({ to: "/settings/$section", params: { section: "billing" } }),
          },
        });
      }),
    [qc, navigate, owner],
  );
  return null;
}
