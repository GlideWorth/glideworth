/**
 * Editor for a DateRef: plan start/end, a calendar month, a person's age, or a milestone with an
 * offset. Shows the resolved meaning in words so users always know what "end" means.
 */
import type { DateRef, Milestone, Person } from "@glideworth/core";
import { Input } from "./input";
import { NumberInput } from "./number-input";
import { Select } from "./select";

type Kind = DateRef["kind"];

const KIND_OPTIONS: { value: Kind; label: string }[] = [
  { value: "planStart", label: "Plan start" },
  { value: "date", label: "Specific month" },
  { value: "age", label: "Age" },
  { value: "milestone", label: "Milestone" },
  { value: "planEnd", label: "Plan end" },
  { value: "never", label: "Never" },
];

export function DateRefPicker({
  value,
  onChange,
  people,
  milestones,
  allowNever = true,
  "aria-label": label,
}: {
  value: DateRef;
  onChange: (v: DateRef) => void;
  people: Person[];
  milestones: Milestone[];
  allowNever?: boolean;
  "aria-label": string;
}) {
  const offset = "offsetMonths" in value ? value.offsetMonths : 0;
  const switchKind = (k: Kind) => {
    switch (k) {
      case "planStart":
      case "planEnd":
        return onChange({ kind: k, offsetMonths: 0 });
      case "never":
        return onChange({ kind: "never" });
      case "date":
        return onChange({
          kind: "date",
          date: new Date().toISOString().slice(0, 7),
          offsetMonths: 0,
        });
      case "age":
        return onChange({ kind: "age", personId: people[0]?.id ?? "", age: 65, offsetMonths: 0 });
      case "milestone":
        return onChange({
          kind: "milestone",
          milestoneId: milestones[0]?.id ?? "",
          offsetMonths: 0,
        });
    }
  };
  return (
    <fieldset
      className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0"
      aria-label={label}
    >
      <Select<Kind>
        aria-label={`${label}: reference`}
        value={value.kind}
        onValueChange={switchKind}
        options={KIND_OPTIONS.filter((o) => allowNever || o.value !== "never")}
        className="w-[150px]"
      />
      {value.kind === "date" ? (
        <Input
          type="month"
          aria-label={`${label}: month`}
          value={value.date}
          onChange={(e) => onChange({ ...value, date: e.target.value })}
          className="w-[150px]"
        />
      ) : null}
      {value.kind === "age" ? (
        <>
          <Select
            aria-label={`${label}: person`}
            value={value.personId}
            onValueChange={(personId) => onChange({ ...value, personId })}
            options={people.map((p) => ({ value: p.id, label: p.name }))}
            className="w-[120px]"
          />
          <NumberInput
            aria-label={`${label}: age`}
            decimals={1}
            value={value.age}
            onValueChange={(age) => onChange({ ...value, age: age ?? 0 })}
            className="w-[80px]"
            suffix="yrs"
          />
        </>
      ) : null}
      {value.kind === "milestone" ? (
        <Select
          aria-label={`${label}: milestone`}
          value={value.milestoneId}
          onValueChange={(milestoneId) => onChange({ ...value, milestoneId })}
          options={milestones.map((m) => ({ value: m.id, label: m.name }))}
          className="w-[180px]"
        />
      ) : null}
      {value.kind !== "never" ? (
        <NumberInput
          aria-label={`${label}: offset in months`}
          decimals={0}
          value={offset}
          onValueChange={(o) => onChange({ ...value, offsetMonths: Math.round(o ?? 0) } as DateRef)}
          className="w-[96px]"
          prefix="±"
          suffix="mo"
        />
      ) : null}
    </fieldset>
  );
}

/** Plain-language description of a DateRef (used in lists and the plan editor). */
export function describeDateRef(ref: DateRef, people: Person[], milestones: Milestone[]): string {
  const off =
    "offsetMonths" in ref && ref.offsetMonths
      ? ` ${ref.offsetMonths > 0 ? "+" : "−"}${Math.abs(ref.offsetMonths)} mo`
      : "";
  switch (ref.kind) {
    case "planStart":
      return `Plan start${off}`;
    case "planEnd":
      return `Plan end${off}`;
    case "never":
      return "Never";
    case "date":
      return `${ref.date}${off}`;
    case "age":
      return `${people.find((p) => p.id === ref.personId)?.name ?? "?"} age ${ref.age}${off}`;
    case "milestone":
      return `${milestones.find((m) => m.id === ref.milestoneId)?.name ?? "?"}${off}`;
  }
}
