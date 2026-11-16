import { z } from "zod";
import {
  Appearance,
  CountryCode,
  CurrencyCode,
  Id,
  LocaleTag,
  MonthDate,
  Timestamp,
} from "./primitives.js";

export const PersonRole = z.enum(["primary", "partner"]).meta({ id: "PersonRole" });

/**
 * A past period of tax residence (before the plan starts). Used by rules that look back: the UK
 * long-term-residence test for inheritance tax (10 of the previous 20 tax years), the UK
 * temporary non-residence rule (UK resident in 4 of the 7 tax years before leaving) and the
 * departure date of someone who already lives abroad. `to` absent = still resident there.
 */
export const PastResidence = z
  .object({
    country: CountryCode,
    from: MonthDate,
    to: MonthDate.optional(),
  })
  .meta({ id: "PastResidence" });
export type PastResidence = z.infer<typeof PastResidence>;

/** A contribution record in a state pension scheme (UK National Insurance qualifying years...). */
export const StatePensionRecord = z
  .object({
    country: CountryCode,
    /** Qualifying years already on the record (UK: full new State Pension needs 35, minimum 10). */
    qualifyingYears: z.number().min(0).max(60),
    /** Month the record was checked (default: the plan start). */
    asOf: MonthDate.optional(),
    /**
     * Years you plan to buy with voluntary contributions (UK Class 2 / Class 3 NI) before State
     * Pension age. Counted towards the projected record; add their cost as an expense.
     */
    voluntaryYears: z.number().int().min(0).max(35).optional(),
  })
  .meta({ id: "StatePensionRecord" });
export type StatePensionRecord = z.infer<typeof StatePensionRecord>;

export const Person = z
  .object({
    id: Id.refine((v) => v !== "joint", "'joint' is reserved"),
    name: z.string().min(1).max(80),
    role: PersonRole,
    /** Birth month. Full date of birth is deliberately not stored. */
    birthMonth: MonthDate,
    /** Optional, used for survivor-benefit and stochastic-lifespan models. */
    sex: z.enum(["female", "male", "unspecified"]).default("unspecified"),
    appearance: Appearance.optional(),
    /**
     * Citizenships (ISO alpha-2). Used by cross-border rules: US citizens stay taxable in the US
     * wherever they live; UK personal allowance for non-residents (British and EEA citizens); treaty
     * clauses that depend on nationality (government pensions). Absent = the household's country.
     */
    citizenships: z.array(CountryCode).max(5).optional(),
    /** Holds a US green card (taxed by the US like a citizen while it lasts). */
    usGreenCard: z.boolean().optional(),
    /** Tax residence before the plan starts (most recent last); absent = always the household's country. */
    residenceHistory: z.array(PastResidence).max(40).optional(),
    /** State pension contribution records (UK qualifying years...). */
    statePensionRecords: z.array(StatePensionRecord).max(10).optional(),
  })
  .meta({ id: "Person" });
export type Person = z.infer<typeof Person>;
export type PersonInput = z.input<typeof Person>;

/** First-class dependents (ProjectionLab has none). Used for credits, 529/RESP timing and templates. */
export const Dependent = z
  .object({
    id: Id,
    name: z.string().min(1).max(80),
    birthMonth: MonthDate,
    /** Age at which the dependent stops being a dependent for tax/household purposes. */
    independentAtAge: z.number().int().min(0).max(40).default(18),
  })
  .meta({ id: "Dependent" });
export type Dependent = z.infer<typeof Dependent>;

/**
 * Tax residence. `region` = US state / CA province / AU state code; `locality` = city tax (e.g. NYC).
 * `Household.location` is where the household lives at the plan start; later moves are the plan's
 * residency timeline (`Plan.residency`) and relocation milestone effects.
 */
export const Location = z
  .object({
    country: CountryCode,
    region: z.string().max(10).optional(),
    locality: z.string().max(40).optional(),
  })
  .meta({ id: "Location" });
export type Location = z.infer<typeof Location>;

export const Household = z
  .object({
    id: Id,
    name: z.string().min(1).max(120),
    planningMode: z.enum(["individual", "couple"]),
    people: z.array(Person).min(1).max(2),
    dependents: z.array(Dependent).default([]),
    location: Location,
    /** Display + base currency. All money in a household is in this currency today. */
    currency: CurrencyCode,
    locale: LocaleTag,
    createdAt: Timestamp.optional(),
    updatedAt: Timestamp.optional(),
  })
  .superRefine((h, ctx) => {
    const primary = h.people.filter((p) => p.role === "primary").length;
    if (primary !== 1)
      ctx.addIssue({ code: "custom", message: "exactly one primary person required" });
    if (h.planningMode === "individual" && h.people.length !== 1)
      ctx.addIssue({ code: "custom", message: "individual households have exactly one person" });
    if (h.planningMode === "couple" && h.people.length !== 2)
      ctx.addIssue({ code: "custom", message: "couple households have exactly two people" });
  })
  .meta({ id: "Household" });
export type Household = z.infer<typeof Household>;
export type HouseholdInput = z.input<typeof Household>;
