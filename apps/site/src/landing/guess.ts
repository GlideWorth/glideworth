/**
 * Which country version of the home page a visitor probably wants, guessed in the browser from the
 * browser's own settings. No network call, no IP address, no third party: a self-hosted copy behaves the
 * same, and nothing here is stored or sent anywhere (the banner script keeps the guess in memory only).
 *
 * This module is loaded by the country banner's client script, so it must stay small and import nothing.
 *
 * Precedence, when the two signals disagree:
 *  1. The time zone, when it belongs to one country. It follows where the computer is set up, which is
 *     usually where the person lives; language settings often stay on en-US wherever people live.
 *  2. Otherwise (no time zone, UTC, or a zone shared by several countries or not in the table), the
 *     region of the first preferred language that has one: en-GB -> GB.
 *  3. Otherwise nothing. A missing guess means "do not suggest anything".
 */

/** ISO 3166-1 alpha-2 code, upper case. */
export type CountryCode = string;

export interface GuessInput {
  /** `navigator.languages` (or `[navigator.language]`). */
  languages?: readonly unknown[] | null;
  /** `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
  timeZone?: unknown;
}

/**
 * IANA zones (including the old aliases browsers still report) that lie in a single country. Only the
 * countries the site may offer a version for, and their close neighbours, need to be here: a zone that is
 * missing simply falls back to the language region.
 */
const ZONES: Record<CountryCode, readonly string[]> = {
  GB: ["Europe/London", "Europe/Belfast", "GB", "GB-Eire"],
  IE: ["Europe/Dublin", "Eire"],
  US: [
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Phoenix",
    "America/Anchorage",
    "America/Juneau",
    "America/Sitka",
    "America/Metlakatla",
    "America/Yakutat",
    "America/Nome",
    "America/Adak",
    "America/Boise",
    "America/Detroit",
    "America/Menominee",
    "America/Indiana/Indianapolis",
    "America/Indiana/Knox",
    "America/Indiana/Marengo",
    "America/Indiana/Petersburg",
    "America/Indiana/Tell_City",
    "America/Indiana/Vevay",
    "America/Indiana/Vincennes",
    "America/Indiana/Winamac",
    "America/Indianapolis",
    "America/Kentucky/Louisville",
    "America/Kentucky/Monticello",
    "America/Louisville",
    "America/North_Dakota/Beulah",
    "America/North_Dakota/Center",
    "America/North_Dakota/New_Salem",
    "Pacific/Honolulu",
    "US/Eastern",
    "US/Central",
    "US/Mountain",
    "US/Pacific",
    "US/Arizona",
    "US/Alaska",
    "US/Hawaii",
    "US/Michigan",
    "US/East-Indiana",
    "US/Indiana-Starke",
    "US/Aleutian",
  ],
  CA: [
    "America/Toronto",
    "America/Montreal",
    "America/Vancouver",
    "America/Edmonton",
    "America/Winnipeg",
    "America/Regina",
    "America/Swift_Current",
    "America/Halifax",
    "America/Glace_Bay",
    "America/Moncton",
    "America/Goose_Bay",
    "America/St_Johns",
    "America/Whitehorse",
    "America/Dawson",
    "America/Dawson_Creek",
    "America/Fort_Nelson",
    "America/Creston",
    "America/Yellowknife",
    "America/Inuvik",
    "America/Cambridge_Bay",
    "America/Iqaluit",
    "America/Rankin_Inlet",
    "America/Resolute",
    "America/Rainy_River",
    "America/Thunder_Bay",
    "America/Nipigon",
    "America/Atikokan",
    "America/Pangnirtung",
    "Canada/Atlantic",
    "Canada/Central",
    "Canada/Eastern",
    "Canada/Mountain",
    "Canada/Newfoundland",
    "Canada/Pacific",
    "Canada/Saskatchewan",
    "Canada/Yukon",
  ],
  AU: [
    "Australia/Sydney",
    "Australia/Melbourne",
    "Australia/Brisbane",
    "Australia/Perth",
    "Australia/Adelaide",
    "Australia/Hobart",
    "Australia/Darwin",
    "Australia/Canberra",
    "Australia/ACT",
    "Australia/NSW",
    "Australia/Victoria",
    "Australia/Queensland",
    "Australia/West",
    "Australia/South",
    "Australia/Tasmania",
    "Australia/North",
    "Australia/Currie",
    "Australia/Lindeman",
    "Australia/Broken_Hill",
    "Australia/Yancowinna",
    "Australia/Lord_Howe",
    "Australia/LHI",
    "Australia/Eucla",
    "Antarctica/Macquarie",
  ],
  NZ: ["Pacific/Auckland", "Pacific/Chatham", "NZ", "NZ-CHAT"],
};

const ZONE_TO_COUNTRY: ReadonlyMap<string, CountryCode> = new Map(
  Object.entries(ZONES).flatMap(([code, zones]) => zones.map((z) => [z, code] as const)),
);

/** The country of a time zone that lies in one country, or undefined. */
export function countryFromTimeZone(timeZone: unknown): CountryCode | undefined {
  if (typeof timeZone !== "string" || timeZone.length > 64) return undefined;
  return ZONE_TO_COUNTRY.get(timeZone.trim());
}

/**
 * The region of a BCP 47 language tag, upper case: "en-GB" -> "GB", "en_au" -> "AU",
 * "zh-Hant-TW" -> "TW". Undefined for a tag with no two-letter region ("en", "es-419") or garbage.
 */
export function regionFromLanguage(tag: unknown): CountryCode | undefined {
  if (typeof tag !== "string" || tag.length > 64) return undefined;
  const parts = tag.trim().split(/[-_]/);
  if (parts.length < 2 || !/^[a-z]{2,3}$/i.test(parts[0] ?? "")) return undefined;
  // The region is the first two-letter subtag after the language (a script subtag has four letters).
  for (const part of parts.slice(1)) {
    if (/^[a-z]{2}$/i.test(part)) return part.toUpperCase();
    if (/^[a-z]{4}$/i.test(part)) continue;
    break;
  }
  return undefined;
}

/** The visitor's likely country, or undefined when unsure. See the precedence at the top of the file. */
export function guessCountry(input: GuessInput): CountryCode | undefined {
  const fromZone = countryFromTimeZone(input.timeZone);
  if (fromZone) return fromZone;
  const languages = Array.isArray(input.languages) ? input.languages.slice(0, 10) : [];
  for (const tag of languages) {
    const region = regionFromLanguage(tag);
    if (region) return region;
  }
  return undefined;
}

// ------------------------------------------------------------------------------------- the banner

/** The browser storage key, and the value that means "the visitor closed the suggestion". */
export const COUNTRY_KEY = "country";
export const COUNTRY_CLOSED = "closed";

/** One country version of the home page, as the banner script receives it from the page. */
export interface VersionLink {
  /** ISO code of the country the version is for. */
  code: CountryCode;
  /** Site path: "/" or "/uk/". */
  path: string;
  /** What the banner calls it: "UK" in "Looking for the UK version?". */
  label: string;
}

/**
 * The version to suggest on the page for `current`, or undefined to show nothing.
 * `stored` is the raw stored `country` value (a code the visitor picked, "closed", or anything else).
 * A closed suggestion stays closed; a picked version beats the guess; nothing is suggested when the
 * preferred country has no version of its own or is the page already shown.
 */
export function suggestedVersion(input: {
  current: CountryCode;
  versions: readonly VersionLink[];
  guess: CountryCode | undefined;
  stored: unknown;
}): VersionLink | undefined {
  const { current, versions, guess, stored } = input;
  if (stored === COUNTRY_CLOSED) return undefined;
  const picked =
    typeof stored === "string" ? versions.find((v) => v.code === stored)?.code : undefined;
  const preferred = picked ?? guess;
  if (!preferred || preferred === current) return undefined;
  return versions.find((v) => v.code === preferred);
}
