/**
 * A blank household for the first import, before guided setup has saved a plan.
 *
 * Until a household exists the app shows the bundled sample (`source: "sample"`, `firstRun`).
 * Previewing and saving that sample would write its invented people and balances as the user's
 * data. The import previews and applies against this blank plan instead, then `persistWorkspace`
 * creates it on the server.
 */
import {
  type CurrentFinances,
  CurrentFinances as CurrentFinancesSchema,
  defaultsForCountry,
  emptyFinances,
  GlideworthDocument,
  type Household,
  Household as HouseholdSchema,
  planDefaultsForHousehold,
  SCHEMA_VERSION,
} from "@glideworth/core";
import { useMemo } from "react";
import { useSession } from "../../lib/auth";
import { countryInfo } from "../../lib/countries";
import { serverReachable, useWorkspace, type Workspace } from "../../lib/workspace";
import { builtInMilestones } from "../plan-editor/state/defaults";

const PLAN_ID = "plan-main";
const PERSON_ID = "p-me";

/** Country implied by a locale tag ("en-GB" → GB). Unknown or unsupported tags use the US. */
export function countryFromLocale(locale: string): string {
  const region = locale.split("-")[1]?.toUpperCase();
  if (region && countryInfo(region)) return region;
  return "US";
}

function clip(s: string, max: number): string {
  const t = s.trim();
  return (t.length <= max ? t : t.slice(0, max)).trim();
}

export function createStarterDocument(
  opts: { personName?: string; locale?: string; now?: Date } = {},
): GlideworthDocument {
  const now = opts.now ?? new Date();
  const locale = opts.locale ?? (typeof navigator !== "undefined" ? navigator.language : "en-US");
  const country = countryFromLocale(locale);
  const preset = defaultsForCountry(country);
  const region = preset.defaultRegion ?? undefined;
  const name = clip(opts.personName || "You", 80) || "You";
  const birthMonth = `${now.getUTCFullYear() - 40}-01`;
  const household: Household = HouseholdSchema.parse({
    id: "hh-main",
    name: clip(`${name}’s household`, 120),
    planningMode: "individual",
    people: [{ id: PERSON_ID, name, role: "primary", birthMonth }],
    location: { country, ...(region ? { region } : {}) },
    currency: preset.currency,
    locale: preset.locale,
  });
  const finances: CurrentFinances = CurrentFinancesSchema.parse(emptyFinances(now));
  return GlideworthDocument.parse({
    app: "glideworth",
    schemaVersion: SCHEMA_VERSION,
    household,
    finances,
    plans: [
      {
        id: PLAN_ID,
        householdId: household.id,
        name: "My plan",
        isMain: true,
        description: "Created from an import. Open the plan to refine it.",
        milestones: builtInMilestones({ household, finances }),
        ...planDefaultsForHousehold(household),
      },
    ],
    progress: [],
    settings: { locale: preset.locale },
  });
}

/**
 * The document an import previews and writes. A new workspace (server up, no household yet) uses a
 * blank plan; an existing household uses that household; a real outage keeps the sample.
 */
export function useImportTarget(): {
  ws: Workspace | undefined;
  doc: GlideworthDocument | undefined;
  reachable: boolean;
} {
  const { data: ws } = useWorkspace();
  const session = useSession();
  const signedIn = session.data?.kind === "authenticated" ? session.data : undefined;
  const personName = signedIn?.cloud?.user.name || signedIn?.user?.name || "You";
  const starter = useMemo(
    () => (ws?.firstRun ? createStarterDocument({ personName }) : null),
    [ws?.firstRun, personName],
  );
  return { ws, doc: starter ?? ws?.doc, reachable: serverReachable(ws) };
}
