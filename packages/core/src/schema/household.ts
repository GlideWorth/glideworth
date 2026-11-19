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
 * `Household.location` is where the household lives for the whole plan: moves are not modelled.
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
