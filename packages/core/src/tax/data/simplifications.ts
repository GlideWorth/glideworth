import { AE_SIMPLIFICATIONS } from "./ae.js";
import {
  AU_SIMPLIFICATIONS,
  CA_FEDERAL_SIMPLIFICATIONS,
  CA_PROVINCE_SIMPLIFICATIONS,
  UK_SIMPLIFICATIONS,
  US_FEDERAL_SIMPLIFICATIONS,
  US_LOCAL_SIMPLIFICATIONS,
  US_PAYROLL_SIMPLIFICATIONS,
  US_STATE_SIMPLIFICATIONS,
} from "./anglo.js";
import { DE_SIMPLIFICATIONS } from "./de.js";
import { ES_SIMPLIFICATIONS } from "./es.js";
import { FR_SIMPLIFICATIONS } from "./fr.js";
import { IE_SIMPLIFICATIONS } from "./ie.js";
import { IL_SIMPLIFICATIONS } from "./il.js";
import { NL_SIMPLIFICATIONS } from "./nl.js";
import { NZ_SIMPLIFICATIONS } from "./nz.js";

/** Known simplifications per jurisdiction id (UI: "what this estimate leaves out"). */
export const TAX_SIMPLIFICATIONS: Readonly<Record<string, readonly string[]>> = {
  uk: UK_SIMPLIFICATIONS,
  "us-federal": US_FEDERAL_SIMPLIFICATIONS,
  "us-payroll": US_PAYROLL_SIMPLIFICATIONS,
  "us-state": US_STATE_SIMPLIFICATIONS,
  "us-local": US_LOCAL_SIMPLIFICATIONS,
  "ca-federal": CA_FEDERAL_SIMPLIFICATIONS,
  "ca-province": CA_PROVINCE_SIMPLIFICATIONS,
  au: AU_SIMPLIFICATIONS,
  de: DE_SIMPLIFICATIONS,
  nl: NL_SIMPLIFICATIONS,
  fr: FR_SIMPLIFICATIONS,
  es: ES_SIMPLIFICATIONS,
  il: IL_SIMPLIFICATIONS,
  ie: IE_SIMPLIFICATIONS,
  nz: NZ_SIMPLIFICATIONS,
  ae: AE_SIMPLIFICATIONS,
};
