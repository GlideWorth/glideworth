/**
 * Analysis pages need a plan. A household without one (new, or every plan deleted) gets a clear
 * empty state with the next step instead of a page that renders only its title.
 */
import { Link } from "@tanstack/react-router";
import { ListPlus } from "lucide-react";
import type { ReactNode } from "react";
import { useActivePlan } from "../../lib/workspace";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { EmptyState } from "../ui/empty-state";
import { Page } from "./app-shell";

export function NoPlanGate({ title, children }: { title: string; children: ReactNode }) {
  const { plan, workspace } = useActivePlan();
  if (!workspace || plan) return <>{children}</>;
  return (
    <Page title={title}>
      <Card>
        <EmptyState
          icon={ListPlus}
          title="No plan yet"
          action={
            <Button asChild size="sm" variant="primary">
              <Link to="/plans">Create a plan</Link>
            </Button>
          }
        >
          This page analyses a plan: your income, spending and milestones projected forward from
          your current finances. Create one to see it here.
        </EmptyState>
      </Card>
    </Page>
  );
}
