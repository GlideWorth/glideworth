/**
 * Security review finding 4: the bank-file and CSV importers run on the API's request thread, so the
 * time they take must grow in proportion to the input and not to its square. Each case builds a
 * crafted input at two sizes, 8x apart, and compares the times: a linear parser takes about 8x as
 * long, a quadratic one about 64x.
 *
 * Set GW_PARSE_TIMINGS=1 to print the measured times.
 */
import { createUkSampleDocument } from "@glideworth/core/samples";
import { describe, expect, it } from "vitest";
import {
  analyzeCsv,
  importBankFileInto,
  parseOfx,
  parseQif,
  summariseBankFile,
} from "../src/index.js";

const SMALL = 50_000;
const LARGE = 400_000;
/** Linear is 8, quadratic is 64. */
const MAX_RATIO = 20;

/** `unit` repeated until the text is `size` characters long. */
const fill = (unit: (i: number) => string, size: number, head = ""): string => {
  const parts = [head];
  let length = head.length;
  for (let i = 0; length < size; i++) {
    const u = unit(i);
    parts.push(u);
    length += u.length;
  }
  return parts.join("");
};

const time = (run: () => unknown): number => {
  const t0 = performance.now();
  run();
  return performance.now() - t0;
};

/**
 * Times `run` on the small and the large input and asserts near-linear growth. The best of several
 * runs is taken at each size, so one slow run (garbage collection, a busy CI machine) does not fail it.
 */
function expectLinear(
  name: string,
  build: (size: number) => string,
  run: (text: string) => unknown,
) {
  const [warm, small, large] = [SMALL / 5, SMALL, LARGE].map(build) as [string, string, string];
  run(warm);
  let tSmall = Infinity;
  for (let i = 0; i < 5; i++)
    tSmall = Math.min(
      tSmall,
      time(() => run(small)),
    );
  // Timings of a few milliseconds are noise; do not let them shrink the allowance. A quadratic
  // parser takes seconds at the large size, far above even this floor.
  const allowed = MAX_RATIO * Math.max(tSmall, 5);
  let tLarge = Infinity;
  for (let i = 0; i < 3 && tLarge > allowed; i++)
    tLarge = Math.min(
      tLarge,
      time(() => run(large)),
    );
  if (process.env.GW_PARSE_TIMINGS)
    console.info(
      `${name}: ${small.length} chars ${tSmall.toFixed(1)} ms, ${large.length} chars ${tLarge.toFixed(1)} ms`,
    );
  expect(
    tLarge,
    `${name}: ${tSmall.toFixed(1)} ms at ${small.length} chars, ${tLarge.toFixed(1)} ms at ${large.length}`,
  ).toBeLessThanOrEqual(allowed);
}

const TIMEOUT = 300_000;

describe("parse time grows linearly with the input (security review finding 4)", () => {
  it(
    "OFX: tags that never close",
    () => {
      expectLinear("ofx unclosed tags", (n) => fill(() => "<A", n, "<OFX>"), parseOfx);
    },
    TIMEOUT,
  );

  it(
    "OFX: many opening tags followed by closing tags that match none of them",
    () => {
      const build = (n: number) =>
        `<OFX>${"<A>".repeat(Math.floor(n / 7))}${"</B>".repeat(Math.floor(n / 7))}`;
      expectLinear("ofx unmatched closing tags", build, parseOfx);
      // 57,000 levels deep: the tree walk must not overflow the call stack.
      expect(() => parseOfx(build(LARGE))).not.toThrow();
    },
    TIMEOUT,
  );

  it(
    "OFX: statements nested in each other's transaction lists",
    () => {
      const build = (n: number) =>
        `<OFX>${"<STMTRS><BANKTRANLIST>".repeat(Math.floor(n / 44))}${fill(
          () => "<STMTTRN><DTPOSTED>20260105<TRNAMT>-1</STMTTRN>",
          n / 2,
        )}`;
      expectLinear("ofx nested statements", build, parseOfx);
      // A transaction belongs to the statement that directly contains it, not to every ancestor too.
      expect(parseOfx(build(SMALL)).transactions.length).toBeLessThan(SMALL / 40);
    },
    TIMEOUT,
  );

  it(
    "QIF: many !Account headers",
    () => {
      expectLinear("qif account headers", (n) => fill((i) => `!Account\nNa${i}\n^\n`, n), parseQif);
    },
    TIMEOUT,
  );

  it(
    "QIF: many accounts and many transactions",
    () => {
      const build = (n: number) =>
        fill((i) => `!Account\nNa${i}\n^\n`, n / 2) +
        fill(() => "!Type:Bank\nD1/5/26\nT-1\n^\n", n / 2, "");
      expectLinear("qif accounts x transactions", build, parseQif);
    },
    TIMEOUT,
  );

  it(
    "bank file: a large categoryMap with many uncategorised transactions",
    () => {
      // The map comes from the same request, so it grows with the file: one entry per 40 characters.
      const maps = new Map<number, Record<string, "living">>();
      expectLinear(
        "bank file categoryMap",
        (n) => {
          const text = fill(() => "D1/5/26\nT-1\nPShop\n^\n", n, "!Type:Bank\n");
          maps.set(
            text.length,
            Object.fromEntries(
              Array.from({ length: Math.floor(n / 40) }, (_, i) => [`payee ${i}`, "living"]),
            ),
          );
          return text;
        },
        (text) => summariseBankFile(text, { format: "qif", categoryMap: maps.get(text.length)! }),
      );
    },
    TIMEOUT,
  );

  it(
    "bank file: creating many accounts whose names shorten to the same id",
    () => {
      const doc = createUkSampleDocument();
      const prefix = "x".repeat(60);
      expectLinear(
        "bank file colliding account ids",
        (n) => fill((i) => `!Account\nN${prefix}${i}\n$1\n^\n`, n),
        (text) =>
          importBankFileInto(doc, text, { format: "qif", balances: { createMissing: true } }),
      );
    },
    TIMEOUT,
  );

  it(
    "CSV: a wide header row above many short rows",
    () => {
      // No column is recognised by name, so every column is sniffed for dates and numbers.
      const build = (n: number) => `${fill((i) => `h${i},`, n / 2)}\n${fill(() => "x\n", n / 2)}`;
      expectLinear("csv column sniffing", build, (text) => analyzeCsv(text, "transactions"));
    },
    TIMEOUT,
  );
});
