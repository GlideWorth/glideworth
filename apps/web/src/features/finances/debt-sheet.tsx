import { DEBT_TYPES, Debt, type DebtBehaviour } from "@glideworth/core";
import { Archive, Trash2 } from "lucide-react";
import { AppearancePicker } from "../../components/ui/appearance-picker";
import { Button } from "../../components/ui/button";
import { confirmAction } from "../../components/ui/confirm-dialog";
import { Input } from "../../components/ui/input";
import { FieldGrid, FormSection, Sheet, SheetClose, SheetContent } from "../../components/ui/sheet";
import { SwitchField } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { useFormat } from "../../lib/workspace";
import { CurrencyPrompt, ItemCountryField } from "../crossborder/fields";
import { CurrencySelect } from "../currency/fx";
import {
  AccountListEditor,
  DateRefField,
  EnumField,
  FormField,
  OwnerSelect,
} from "../plan-editor/components/form";
import { DEBT_TYPES_LABEL } from "../plan-editor/state/labels";
import { useIssues } from "../plan-editor/state/validation";
import { InterestPaymentFields } from "./asset-sheet";
import { updateFinances, useDraftDoc } from "./use-finances";

export function DebtSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      {id ? <DebtSheetBody id={id} onClose={onClose} /> : null}
    </Sheet>
  );
}

function DebtSheetBody({ id, onClose }: { id: string; onClose: () => void }) {
  const doc = useDraftDoc();
  const f = useFormat();
  const debt = doc?.finances.debts.find((d) => d.id === id);
  const issues = useIssues(Debt, debt);
  if (!doc || !debt) return null;
  const update = (fn: (d: Debt) => Debt, label: string, coalesce?: string) =>
    updateFinances(
      (fin) => ({ ...fin, debts: fin.debts.map((d) => (d.id === id ? fn(d) : d)) }),
      label,
      coalesce ? `${id}:${coalesce}` : undefined,
    );
  const setB = (b: Partial<DebtBehaviour>, label: string) =>
    update((d) => ({ ...d, behaviour: { ...d.behaviour, ...b } }), label);
  const remove = async () => {
    if (
      !(await confirmAction({
        title: `Delete ${debt.name}?`,
        description: "You can undo this.",
        confirmLabel: "Delete",
      }))
    )
      return;
    onClose();
    updateFinances(
      (fin) => ({ ...fin, debts: fin.debts.filter((d) => d.id !== id) }),
      `Delete ${debt.name}`,
    );
  };
  return (
    <SheetContent
      eyebrow="Debt"
      title={debt.name || "Untitled debt"}
      description={`${debt.currency ? f.moneyIn(debt.balance, debt.currency) : f.money(debt.balance)} at ${f.percent(debt.interest.apr, 2)} APR`}
      width={580}
      footer={
        <>
          <Button variant="ghost" size="sm" className="text-negative" onClick={remove}>
            <Trash2 /> Delete
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => update((d) => ({ ...d, archived: !d.archived }), "Archive debt")}
          >
            <Archive /> {debt.archived ? "Restore" : "Archive"}
          </Button>
          <SheetClose asChild>
            <Button variant="primary" className="ml-auto">
              Done
            </Button>
          </SheetClose>
        </>
      }
    >
      <FormSection title="Details">
        <FieldGrid>
          <FormField label="Name" error={issues.get("name")}>
            {(fid) => (
              <Input
                id={fid}
                value={debt.name}
                onChange={(e) =>
                  update((d) => ({ ...d, name: e.target.value }), "Rename debt", "name")
                }
              />
            )}
          </FormField>
          <EnumField
            label="Type"
            value={debt.type}
            onChange={(type) => update((d) => ({ ...d, type }), "Change debt type")}
            options={DEBT_TYPES.map((t) => ({ value: t, label: DEBT_TYPES_LABEL[t] ?? t }))}
          />
          <FormField label="Owner">
            {(fid) => (
              <OwnerSelect
                id={fid}
                value={debt.owner}
                onChange={(owner) => update((d) => ({ ...d, owner }), "Change owner")}
              />
            )}
          </FormField>
          <ItemCountryField
            value={debt.country}
            inherited={doc.household.location.country}
            inheritedWhy="household"
            label="Lender's country"
            onChange={(country) => update((d) => ({ ...d, country }), "Change debt country")}
            help="Where the lender is. Debts are not taxed, but a debt abroad is usually in that country's currency."
          />
          <FormField
            label="Currency"
            hint={debt.currency ? "The balance and payments are in this currency." : undefined}
          >
            {(fid) => (
              <CurrencySelect
                id={fid}
                value={debt.currency}
                base={doc.household.currency}
                onChange={(currency) => update((d) => ({ ...d, currency }), "Change debt currency")}
              />
            )}
          </FormField>
          <div className="sm:col-span-2">
            <CurrencyPrompt
              what="This debt"
              country={debt.country ?? doc.household.location.country}
              currency={debt.currency}
              onUseCurrency={(currency) =>
                update((d) => ({ ...d, currency }), "Change debt currency")
              }
            />
          </div>
        </FieldGrid>
      </FormSection>
      <FormSection title="Balance & repayments">
        <InterestPaymentFields
          balance={debt.balance}
          interest={debt.interest}
          payment={debt.monthlyPayment}
          issues={issues}
          asOf={doc.finances.asOf}
          onChange={(v) =>
            update(
              (d) => ({
                ...d,
                ...(v.balance !== undefined ? { balance: v.balance } : {}),
                ...(v.interest ? { interest: v.interest } : {}),
                ...(v.monthlyPayment ? { monthlyPayment: v.monthlyPayment } : {}),
              }),
              "Edit repayments",
              "terms",
            )
          }
        />
      </FormSection>
      <FormSection title="Payments">
        <DateRefField
          label="Payments start"
          value={debt.behaviour.paymentsStart}
          onChange={(paymentsStart) => setB({ paymentsStart }, "Edit payment start")}
          allowNever={false}
          help="E.g. a student loan that starts repaying after graduation."
        />
        <EnumField<"auto" | "accounts">
          label="Paid from"
          value={debt.behaviour.payFrom.kind}
          onChange={(k) =>
            setB(
              { payFrom: k === "auto" ? { kind: "auto" } : { kind: "accounts", accountIds: [] } },
              "Edit pay from",
            )
          }
          options={[
            { value: "auto", label: "Cash flow (automatic)" },
            { value: "accounts", label: "Specific accounts" },
          ]}
        />
        {debt.behaviour.payFrom.kind === "accounts" ? (
          <AccountListEditor
            ids={debt.behaviour.payFrom.accountIds}
            onChange={(accountIds) =>
              setB({ payFrom: { kind: "accounts", accountIds } }, "Edit pay from")
            }
          />
        ) : null}
        {issues.under("behaviour.payFrom") ? (
          <p className="text-[11.5px] text-negative">{issues.under("behaviour.payFrom")}</p>
        ) : null}
        <SwitchField
          label="Interest is tax-deductible"
          checked={debt.behaviour.interestTaxDeductible}
          onCheckedChange={(v) => setB({ interestTaxDeductible: v }, "Toggle deductible")}
        />
      </FormSection>
      <FormSection
        title="Forgiveness"
        description="UK student loans are written off after a fixed term; US PSLF forgives after 10 years of payments."
      >
        <SwitchField
          label="Written off at a point in time"
          checked={!!debt.behaviour.forgiveness}
          onCheckedChange={(on) =>
            setB(
              {
                forgiveness: on
                  ? { at: { kind: "planStart", offsetMonths: 12 * 25 }, taxable: false }
                  : undefined,
              },
              on ? "Add forgiveness" : "Remove forgiveness",
            )
          }
        />
        {debt.behaviour.forgiveness ? (
          <>
            <DateRefField
              label="Written off at"
              value={debt.behaviour.forgiveness.at}
              onChange={(at) =>
                setB({ forgiveness: { ...debt.behaviour.forgiveness!, at } }, "Edit forgiveness")
              }
              allowNever={false}
            />
            <SwitchField
              label="Forgiven amount is taxable"
              checked={debt.behaviour.forgiveness.taxable}
              onCheckedChange={(taxable) =>
                setB(
                  { forgiveness: { ...debt.behaviour.forgiveness!, taxable } },
                  "Edit forgiveness",
                )
              }
            />
          </>
        ) : null}
      </FormSection>
      <FormSection title="Notes & appearance">
        <Textarea
          aria-label="Notes"
          value={debt.notes ?? ""}
          onChange={(e) =>
            update((d) => ({ ...d, notes: e.target.value || undefined }), "Edit notes", "notes")
          }
        />
        <AppearancePicker
          value={debt.appearance}
          onChange={(appearance) => update((d) => ({ ...d, appearance }), "Change appearance")}
        />
      </FormSection>
    </SheetContent>
  );
}
