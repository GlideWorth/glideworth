/**
 * Residency timeline and cross-border tax settings (see ARCHITECTURE.md §4.6).
 *
 * A person's tax residence starts as `Household.location` (or their last `residenceHistory` entry
 * without an end) and changes at each `Plan.residency` entry that applies to them, in date order.
 * Relocation milestone effects (`relocate`) add entries too, from the first period starting at or
 * after the milestone. Entries dated inside a period split that period: each residence is taxed on
 * its share of the period's items, pro rata to months (see `tax/crossborder`).
 */
import { z } from "zod";
import { Location } from "./household.js";
import { Id, Notes } from "./primitives.js";
import { DateRef } from "./time.js";

export const ResidencyChange = z
  .object({
    id: Id,
    /** Person who moves; absent = everyone in the household. */
    personId: Id.optional(),
    /** First month of the new residence (a DateRef, so it can follow a milestone). */
    from: DateRef,
    location: Location,
    notes: Notes.optional(),
  })
  .meta({ id: "ResidencyChange" });
export type ResidencyChange = z.infer<typeof ResidencyChange>;
export type ResidencyChangeInput = z.input<typeof ResidencyChange>;

/** Plan-level switches for the cross-border model (TaxConfig.crossBorder). Every field is optional. */
export const CrossBorderSettings = z
  .object({
    /** 'auto' (default): cross-border rules apply when residence or an item's country differs. */
    mode: z.enum(["auto", "off"]).optional(),
    /**
     * Departure taxes (Canada deemed disposition, Australian CGT event I1): 'apply' (default) taxes
     * the unrealised gain in the year of departure; 'defer' records no gain (the elections that defer
     * the tax until a real sale; Glideworth then keeps the original cost basis).
     */
    departureTax: z.enum(["apply", "defer"]).optional(),
    /** UK temporary non-residence: tax gains realised abroad in the year of return (default true). */
    ukTemporaryNonResidence: z.boolean().optional(),
    /** Freeze a UK State Pension while living in a country where it is not uprated (default true). */
    freezeStatePensionAbroad: z.boolean().optional(),
    /**
     * Per-pair override of how a residence country treats a foreign wrapper: key
     * `<residence>:<accountCountry>:<accountType>` -> recognised (true) or not (false).
     */
    wrapperRecognition: z.record(z.string(), z.boolean()).optional(),
  })
  .meta({ id: "CrossBorderSettings" });
export type CrossBorderSettings = z.infer<typeof CrossBorderSettings>;
