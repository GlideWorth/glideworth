/**
 * Cross-page intents: "open the plan editor on Flows", "add an ISA" from the command palette or
 * a link on another page. The target page consumes the intent once on mount.
 */
import type {
  AccountType,
  Debt,
  ExpenseType,
  Flow,
  IncomeType,
  RealAssetType,
} from "@glideworth/core";
import { useEffect, useRef } from "react";
import { create } from "zustand";

export const SECTIONS = [
  { id: "timeline", label: "Timeline" },
  { id: "milestones", label: "Milestones" },
  { id: "residency", label: "Where you live" },
  { id: "income", label: "Income" },
  { id: "expenses", label: "Expenses" },
  { id: "flows", label: "Flows" },
  { id: "accounts", label: "Accounts" },
  { id: "assets", label: "Property & debts" },
  { id: "withdrawals", label: "Withdrawals" },
  { id: "assumptions", label: "Assumptions" },
  { id: "taxes", label: "Taxes" },
  { id: "montecarlo", label: "Chance of success" },
  { id: "whatif", label: "What-if" },
  { id: "details", label: "Plan details" },
] as const;
export type SectionId = (typeof SECTIONS)[number]["id"];

export type Intent =
  | { kind: "section"; section: SectionId }
  | { kind: "add-income"; type: IncomeType }
  | { kind: "add-expense"; type: ExpenseType }
  | { kind: "add-milestone" }
  | { kind: "open-item"; item: "income" | "expense" | "milestone" | "flow"; id: string }
  | { kind: "add-flow"; flowKind: Flow["kind"] }
  | { kind: "add-account"; type: AccountType }
  | { kind: "add-asset"; type: RealAssetType; financed?: boolean }
  | { kind: "add-debt"; type: Debt["type"] }
  | { kind: "edit-household" }
  | { kind: "new-plan" };

/** The editor section that lists each kind of plan item. */
export const SECTION_OF_ITEM = {
  income: "income",
  expense: "expenses",
  milestone: "milestones",
  flow: "flows",
} as const satisfies Record<string, SectionId>;

export const useIntentStore = create<{ intent: Intent | null }>(() => ({ intent: null }));

export function setIntent(intent: Intent) {
  useIntentStore.setState({ intent });
}

/** Run `handle` for a pending intent (now or when one arrives) while mounted. */
export function useConsumeIntent(handle: (i: Intent) => boolean, ready = true) {
  const intent = useIntentStore((s) => s.intent);
  const ref = useRef(handle);
  ref.current = handle;
  useEffect(() => {
    // Claim from the store (not the render value) so StrictMode's double effect runs it once.
    const current = useIntentStore.getState().intent;
    if (!ready || !current) return;
    useIntentStore.setState({ intent: null });
    if (!ref.current(current)) useIntentStore.setState({ intent: current });
  }, [intent, ready]);
}
