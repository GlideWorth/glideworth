import type { CsvKind, Field } from "@glideworth/importers";

/**
 * OFX, QFX and QIF parsing was removed on purpose. Recognise those files on the CSV tab and
 * refuse them, instead of reading the statement as a broken spreadsheet.
 */
const CSV_HEADER: Record<CsvKind, string> = {
  "account-balances": "Account name, Balance",
  "progress-snapshots": "Date, Net worth",
  transactions: "Date, Amount (signed), Category",
};

export function unsupportedBankFileMessage(
  file: { name: string; text: string },
  kind: CsvKind,
): string | null {
  const format = bankFormat(file);
  if (!format) return null;
  return `${format} files are not supported. Export the statement as a CSV and drop that file here. A header row such as ${CSV_HEADER[kind]} matches this choice.`;
}

function bankFormat(file: { name: string; text: string }): "OFX" | "QFX" | "QIF" | null {
  const ext = extension(file.name);
  if (ext === "qfx") return "QFX";
  if (ext === "ofx") return "OFX";
  if (ext === "qif") return "QIF";
  if (looksLikeOfx(file.text)) return "OFX";
  if (looksLikeQif(file.text)) return "QIF";
  return null;
}

function extension(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function head(text: string): string {
  return text.replace(/^\uFEFF/, "").slice(0, 1200);
}

function looksLikeOfx(text: string): boolean {
  const h = head(text);
  const start = h.trimStart();
  if (/^OFXHEADER\s*:/i.test(start)) return true;
  if (/^<\?OFX\b/i.test(start)) return true;
  if (/^<OFX[\s>]/i.test(start)) return true;
  return /^<\?xml\b/i.test(start) && /<OFX[\s>]/i.test(h);
}

function looksLikeQif(text: string): boolean {
  const start = head(text).trimStart();
  return /^!(?:Type|Option)\s*:/i.test(start) || /^!Account\b/i.test(start);
}

/** The mapping form's own words for a file that is still missing required columns. */
export function requiredColumnNote(
  missing: readonly Field[],
  fields: readonly { field: Field; label: string }[],
): string {
  const labels = missing.map((f) => fields.find((x) => x.field === f)?.label ?? f);
  if (labels.length === 0) return "Required: choose a column.";
  return `Required: choose a column for ${joinWords(labels)}.`;
}

function joinWords(items: readonly string[]): string {
  const last = items.at(-1) ?? "";
  if (items.length <= 1) return last;
  const head = items.slice(0, -1);
  return items.length === 2 ? `${head[0] ?? ""} and ${last}` : `${head.join(", ")} and ${last}`;
}
