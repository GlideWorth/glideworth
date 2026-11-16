import type {
  EmailCategory,
  EmailLogStore,
  SuppressionReason,
  SuppressionReasonLookup,
  SuppressionStore,
  TemplateId,
} from "./types.js";

export type MemorySuppressionStore = SuppressionStore &
  SuppressionReasonLookup & {
    entries(): { email: string; category: EmailCategory | "all"; reason: SuppressionReason }[];
  };

/** In-memory suppression list for tests and single-process use. Category `all` covers every category. */
export function memorySuppressionStore(): MemorySuppressionStore {
  const map = new Map<string, SuppressionReason>();
  const key = (email: string, category: EmailCategory | "all") => `${category}\u0000${email}`;
  return {
    isSuppressed(email, category) {
      return map.has(key(email, category)) || map.has(key(email, "all"));
    },
    reasonFor(email, category) {
      return map.get(key(email, category)) ?? map.get(key(email, "all")) ?? null;
    },
    suppress(email, category, reason) {
      const k = key(email, category);
      if (!map.has(k)) map.set(k, reason);
    },
    entries() {
      return [...map].map(([k, reason]) => {
        const [category = "", email = ""] = k.split("\u0000");
        return { email, category: category as EmailCategory | "all", reason };
      });
    },
  };
}

export type EmailLogEntry = Parameters<EmailLogStore["record"]>[0];

/**
 * In-memory email log. Stores exactly the five fields of the interface and nothing else: no recipient
 * address, subject, body, link or token.
 */
export function memoryEmailLog(): EmailLogStore & { entries: EmailLogEntry[]; clear(): void } {
  const entries: EmailLogEntry[] = [];
  return {
    entries,
    record(e) {
      entries.push({
        userId: e.userId,
        template: e.template as TemplateId,
        category: e.category,
        status: e.status,
        providerMessageId: e.providerMessageId,
      });
    },
    clear() {
      entries.length = 0;
    },
  };
}
