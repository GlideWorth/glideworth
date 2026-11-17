/**
 * OFX (Open Financial Exchange) statements: both the SGML 1.x form (unclosed leaf tags) and the XML
 * 2.x form. Reads bank, credit-card and investment statements: the account (masked to its last four
 * digits, never the full number), its currency, the ledger balance and the transactions.
 */
import type { ImportIssue } from "../types.js";
import type { BankAccount, BankParse, BankTransaction } from "./types.js";
import { table } from "../util/read.js";

interface Node {
  tag: string;
  value?: string;
  children: Node[];
}

const decode = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();

/** A character of a tag name: `[A-Za-z0-9._]`. */
const isNameChar = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95;

/**
 * Parse the `<OFX>` body into a tree; leaf elements carry `value` (closing tags optional).
 *
 * The file is untrusted and this runs on the API's request thread, so the scan is one pass: every
 * step moves forward in the text, and a closing tag finds its aggregate without searching the stack.
 */
export function parseOfxTree(text: string): Node | null {
  const start = text.search(/<OFX>/i);
  if (start < 0) return null;
  const body = text.slice(start);
  const root: Node = { tag: "ROOT", children: [] };
  const stack: Node[] = [root];
  /** Tag name -> the stack indexes of the open aggregates with that name, innermost last. */
  const open = new Map<string, number[]>();
  // A token is `<`, an optional `/`, a name, anything up to `>`, then the text up to the next `<`.
  let pos = 0;
  for (;;) {
    const lt = body.indexOf("<", pos);
    if (lt < 0) break;
    let i = lt + 1;
    const closing = body.charCodeAt(i) === 47;
    if (closing) i += 1;
    const nameStart = i;
    while (isNameChar(body.charCodeAt(i))) i += 1;
    if (i === nameStart) {
      // Not a tag (`<` followed by something else): skip this `<`.
      pos = lt + 1;
      continue;
    }
    const gt = body.indexOf(">", i);
    // No `>` in the rest of the file: nothing after this point can be a tag.
    if (gt < 0) break;
    const next = body.indexOf("<", gt + 1);
    pos = next < 0 ? body.length : next;
    const tag = body.slice(nameStart, i).toUpperCase();
    if (closing) {
      // Pop to the matching aggregate (a closing tag for a leaf that was already completed is a no-op).
      const at = open.get(tag)?.at(-1);
      if (at !== undefined) {
        for (let k = stack.length - 1; k >= at; k--) open.get(stack[k]!.tag)!.pop();
        stack.length = at;
      }
      continue;
    }
    const value = decode(body.slice(gt + 1, pos));
    const node: Node = { tag, children: [] };
    stack[stack.length - 1]!.children.push(node);
    if (value !== "") node.value = value;
    else {
      const depths = open.get(tag);
      if (depths) depths.push(stack.length);
      else open.set(tag, [stack.length]);
      stack.push(node);
    }
  }
  return root.children[0] ?? null;
}

const STATEMENT_TAGS = new Set(["STMTRS", "CCSTMTRS", "INVSTMTRS"]);

const find = (n: Node | undefined, tag: string): Node | undefined =>
  n?.children.find((c) => c.tag === tag);
/**
 * Every descendant of `n` with this tag, in document order. A loop, not recursion: a crafted file
 * can nest hundreds of thousands of levels. With `withinStatement` the walk stops at a nested
 * statement, so that statements nested in each other are each read once, not once per ancestor.
 */
const findAll = (n: Node | undefined, tag: string, withinStatement = false): Node[] => {
  const out: Node[] = [];
  if (!n) return out;
  const pending: Node[] = [];
  const pushChildren = (x: Node) => {
    for (let i = x.children.length - 1; i >= 0; i--) pending.push(x.children[i]!);
  };
  pushChildren(n);
  for (let c = pending.pop(); c; c = pending.pop()) {
    if (c.tag === tag) out.push(c);
    if (withinStatement && STATEMENT_TAGS.has(c.tag)) continue;
    pushChildren(c);
  }
  return out;
};
const val = (n: Node | undefined, tag: string): string | undefined => find(n, tag)?.value;

/** OFX date 'YYYYMMDD[HHMMSS[.XXX]][[TZ]]' -> 'YYYY-MM-DD'. */
export function ofxDate(s: string | undefined): string | undefined {
  const m = s ? /^(\d{4})(\d{2})(\d{2})/.exec(s) : null;
  if (!m) return undefined;
  const [, y, mo, d] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return undefined;
  return `${y}-${mo}-${d}`;
}

const num = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  const v = Number(s.replace(/,/g, ".").replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(v) ? v : undefined;
};

/** Last four characters of an account number (the full number is never kept). */
export const maskAccount = (id: string | undefined): string =>
  id ? `••${id.replace(/\s+/g, "").slice(-4)}` : "••";

const ACCT_TYPE: Record<string, { type: string; label: string }> = table({
  CHECKING: { type: "cash", label: "Current account" },
  SAVINGS: { type: "savings", label: "Savings account" },
  MONEYMRKT: { type: "savings", label: "Money market account" },
  CREDITLINE: { type: "cash", label: "Credit line" },
  CD: { type: "certificate", label: "Certificate of deposit" },
});

export function parseOfx(text: string): BankParse {
  const issues: ImportIssue[] = [];
  const tree = parseOfxTree(text);
  if (!tree)
    return {
      format: "ofx",
      accounts: [],
      transactions: [],
      issues: [
        {
          severity: "error",
          category: "invalid",
          sourcePath: "ofx",
          message: "no <OFX> element found",
          code: "ofx.invalid",
        },
      ],
    };
  const accounts: BankAccount[] = [];
  const transactions: BankTransaction[] = [];
  const statements = [
    ...findAll(tree, "STMTRS").map((n) => ({ n, kind: "bank" as const })),
    ...findAll(tree, "CCSTMTRS").map((n) => ({ n, kind: "card" as const })),
    ...findAll(tree, "INVSTMTRS").map((n) => ({ n, kind: "investment" as const })),
  ];
  if (statements.length === 0)
    issues.push({
      severity: "warning",
      category: "invalid",
      sourcePath: "ofx",
      message: "no bank, credit-card or investment statement in the file",
      code: "ofx.no-statement",
    });
  statements.forEach(({ n, kind }, si) => {
    const from = find(n, "BANKACCTFROM") ?? find(n, "CCACCTFROM") ?? find(n, "INVACCTFROM");
    const acctType = val(from, "ACCTTYPE")?.toUpperCase();
    const mapped = acctType ? ACCT_TYPE[acctType] : undefined;
    const masked = maskAccount(val(from, "ACCTID"));
    const label =
      kind === "card"
        ? "Credit card"
        : kind === "investment"
          ? "Investment account"
          : (mapped?.label ?? "Bank account");
    const key = `ofx:${si}:${masked}`;
    const currency = val(n, "CURDEF");
    let balance: number | undefined;
    let balanceDate: string | undefined;
    if (kind === "investment") {
      const cash = num(val(find(n, "INVBAL"), "AVAILCASH")) ?? 0;
      const positions = findAll(find(n, "INVPOSLIST"), "MKTVAL", true).reduce(
        (s, x) => s + (num(x.value) ?? 0),
        0,
      );
      balance = cash + positions;
      balanceDate = ofxDate(val(n, "DTASOF")) ?? ofxDate(val(find(n, "INVPOSLIST"), "DTPRICEASOF"));
    } else {
      const ledger = find(n, "LEDGERBAL");
      balance = num(val(ledger, "BALAMT"));
      balanceDate = ofxDate(val(ledger, "DTASOF"));
    }
    const entity =
      kind === "card" ||
      (balance !== undefined && balance < 0 && kind === "bank" && acctType === "CREDITLINE")
        ? "debt"
        : "account";
    accounts.push({
      key,
      name: `${label} ${masked}`,
      ...(kind === "investment"
        ? { type: "taxable" }
        : kind === "bank" && mapped
          ? { type: mapped.type }
          : {}),
      entity,
      ...(currency && /^[A-Z]{3}$/.test(currency) ? { currency } : {}),
      ...(balance !== undefined
        ? { balance: entity === "debt" ? Math.abs(balance) : balance }
        : {}),
      ...(balanceDate ? { balanceDate } : {}),
    });
    const list = find(n, "BANKTRANLIST") ?? find(n, "INVTRANLIST");
    const trns = kind === "investment" ? [] : findAll(list, "STMTTRN", true);
    trns.forEach((t, ti) => {
      const date = ofxDate(val(t, "DTPOSTED") ?? val(t, "DTUSER"));
      const amount = num(val(t, "TRNAMT"));
      const path = `ofx:statement[${si}].transaction[${ti}]`;
      if (!date || amount === undefined) {
        issues.push({
          severity: "warning",
          category: "invalid",
          sourcePath: path,
          message: "transaction without a valid date or amount; skipped",
          code: "ofx.bad-transaction",
        });
        return;
      }
      transactions.push({
        accountKey: key,
        date,
        amount,
        type: (val(t, "TRNTYPE") ?? "").toUpperCase(),
        payee: val(t, "NAME") ?? val(find(t, "PAYEE"), "NAME") ?? "",
        memo: val(t, "MEMO") ?? "",
        ...(val(t, "CATEGORY") ? { category: val(t, "CATEGORY")! } : {}),
        statement: kind,
      });
    });
  });
  return { format: "ofx", accounts, transactions, issues };
}
