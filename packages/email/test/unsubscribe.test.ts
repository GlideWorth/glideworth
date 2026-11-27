import { describe, expect, it } from "vitest";
import { hmacUnsubscribeSigner } from "../src/index.js";

const key = new Uint8Array(32).map((_, i) => i + 1);
const base = "https://app.example.test";
const tokenOf = (url: string) => new URL(url).searchParams.get("t") ?? "";

describe("hmacUnsubscribeSigner", () => {
  const signer = hmacUnsubscribeSigner({ key, baseUrl: `${base}/` });

  it("builds the one-click URL on the base URL", () => {
    const url = signer.url("sam@example.test", "checkin");
    expect(url.startsWith(`${base}/email/unsubscribe?t=`)).toBe(true);
  });

  it("round-trips", () => {
    const t = tokenOf(signer.url("sam@example.test", "checkin"));
    expect(signer.verify(t)).toEqual({ email: "sam@example.test", category: "checkin" });
  });

  it("signs and verifies marketing (list) mail, and refuses the one-off requested category", () => {
    const t = tokenOf(signer.url("sam@example.test", "marketing"));
    expect(signer.verify(t)).toEqual({ email: "sam@example.test", category: "marketing" });
    expect(() => signer.url("sam@example.test", "requested")).toThrow();
  });

  it("is deterministic for the same input and time", () => {
    const s = hmacUnsubscribeSigner({ key, baseUrl: base, now: () => 1_000_000 });
    expect(s.url("a@example.test", "checkin")).toBe(s.url("a@example.test", "checkin"));
  });

  it("refuses to sign essential mail, and rejects a forged essential token", () => {
    expect(() => signer.url("sam@example.test", "essential")).toThrow();
    const t = tokenOf(signer.url("sam@example.test", "checkin"));
    const [payload = ""] = t.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString()),
        c: "essential",
      }),
    ).toString("base64url");
    expect(signer.verify(`${forged}.${t.split(".")[1]}`)).toBeNull();
  });

  it("rejects tampering with the payload or the signature", () => {
    const t = tokenOf(signer.url("sam@example.test", "checkin"));
    const [payload = "", sig = ""] = t.split(".");
    const other = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString()),
        e: "victim@example.test",
      }),
    ).toString("base64url");
    expect(signer.verify(`${other}.${sig}`)).toBeNull();
    // Tamper with a byte of the MAC, not a character: the last base64url character carries only
    // 4 significant bits, so changing it can leave the decoded bytes (and the MAC) unchanged.
    const bytes = Buffer.from(sig, "base64url");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01;
    expect(signer.verify(`${payload}.${bytes.toString("base64url")}`)).toBeNull();
    bytes[0] = (bytes[0] ?? 0) ^ 0x80;
    expect(signer.verify(`${payload}.${bytes.toString("base64url")}`)).toBeNull();
  });

  it("rejects a non-canonical spelling of a valid signature (unused trailing bits set)", () => {
    const t = tokenOf(signer.url("sam@example.test", "checkin"));
    const [payload = "", sig = ""] = t.split(".");
    expect(signer.verify(t)).not.toBeNull();
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(sig.slice(-1));
    // The last character holds 4 bits of MAC and 2 unused bits: the other three characters that
    // share its top four bits decode to the same bytes.
    const variants = [0, 1, 2, 3]
      .map((low) => alphabet[(last & ~3) | low]!)
      .filter((c) => c !== sig.slice(-1));
    expect(variants).toHaveLength(3);
    for (const v of variants) {
      const alt = `${payload}.${sig.slice(0, -1)}${v}`;
      expect(
        Buffer.from(alt.split(".")[1]!, "base64url").equals(Buffer.from(sig, "base64url")),
      ).toBe(true);
      expect(signer.verify(alt)).toBeNull();
    }
  });

  it("rejects a token signed with a different key", () => {
    const other = hmacUnsubscribeSigner({ key: new Uint8Array(32).fill(9), baseUrl: base });
    expect(signer.verify(tokenOf(other.url("sam@example.test", "checkin")))).toBeNull();
  });

  it.each(["", "abc", "a.b", ".", "x".repeat(2000), "a.b.c", '{"e":"x"}'])(
    "rejects junk %j",
    (t) => {
      expect(signer.verify(t)).toBeNull();
    },
  );

  it("rejects non-string input", () => {
    expect(signer.verify(undefined as never)).toBeNull();
    expect(signer.verify(null as never)).toBeNull();
  });

  it("never expires by default, and expires when a ttl is set", () => {
    let now = 1_700_000_000_000;
    const noTtl = hmacUnsubscribeSigner({ key, baseUrl: base, now: () => now });
    const withTtl = hmacUnsubscribeSigner({ key, baseUrl: base, ttlMs: 60_000, now: () => now });
    const a = tokenOf(noTtl.url("sam@example.test", "checkin"));
    const b = tokenOf(withTtl.url("sam@example.test", "checkin"));
    now += 59_000;
    expect(withTtl.verify(b)).not.toBeNull();
    now += 2_000;
    expect(withTtl.verify(b)).toBeNull();
    now += 10 * 365 * 24 * 3600 * 1000;
    expect(noTtl.verify(a)).not.toBeNull();
  });

  it("requires a key of at least 16 bytes", () => {
    expect(() => hmacUnsubscribeSigner({ key: new Uint8Array(8), baseUrl: base })).toThrow();
  });
});
