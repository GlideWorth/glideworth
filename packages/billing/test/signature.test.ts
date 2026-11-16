import { createHmac } from "node:crypto";
import { Stripe } from "stripe";
import { describe, expect, it } from "vitest";
import { BillingError } from "../src/errors.js";
import {
  constructEvent,
  parseEventBody,
  parseSignatureHeader,
  signPayload,
  verifySignature,
} from "../src/signature.js";

const SECRET = "whsec_primary_secret_value";
const OLD_SECRET = "whsec_previous_secret_value";
const NOW = 1_800_000_000;
const BODY = JSON.stringify({
  id: "evt_123",
  object: "event",
  type: "customer.subscription.updated",
  created: NOW - 5,
  livemode: false,
  data: { object: { id: "sub_123", object: "subscription", customer: "cus_1", status: "active" } },
});

function hmac(t: number, body: string, secret: string): string {
  return createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
}

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BillingError);
    expect((err as BillingError).code).toBe("SIGNATURE_INVALID");
    return String((err as BillingError).details?.reason);
  }
  throw new Error("expected SIGNATURE_INVALID");
}

describe("verifySignature (own implementation, docs.stripe.com/webhooks manual verification)", () => {
  it("accepts a correct v1 signature", () => {
    const header = `t=${NOW},v1=${hmac(NOW, BODY, SECRET)}`;
    expect(verifySignature(BODY, header, SECRET, 300, NOW)).toEqual({ timestamp: NOW });
  });

  it("rejects a missing or empty header", () => {
    expect(reason(() => verifySignature(BODY, undefined, SECRET, 300, NOW))).toBe("missing_header");
    expect(reason(() => verifySignature(BODY, "", SECRET, 300, NOW))).toBe("missing_header");
    expect(reason(() => verifySignature(BODY, "   ", SECRET, 300, NOW))).toBe("missing_header");
  });

  it("rejects malformed headers", () => {
    const sig = hmac(NOW, BODY, SECRET);
    expect(reason(() => verifySignature(BODY, `v1=${sig}`, SECRET, 300, NOW))).toBe("no_timestamp");
    expect(reason(() => verifySignature(BODY, `t=${NOW}`, SECRET, 300, NOW))).toBe("no_signatures");
    expect(reason(() => verifySignature(BODY, `t=${NOW},v1=zz`, SECRET, 300, NOW))).toBe(
      "no_signatures",
    );
    expect(reason(() => verifySignature(BODY, `t=abc,v1=${sig}`, SECRET, 300, NOW))).toBe(
      "malformed_header",
    );
    expect(
      reason(() => verifySignature(BODY, `t=${NOW},t=${NOW},v1=${sig}`, SECRET, 300, NOW)),
    ).toBe("malformed_header");
    expect(reason(() => verifySignature(BODY, `garbage`, SECRET, 300, NOW))).toBe(
      "malformed_header",
    );
    expect(reason(() => verifySignature(BODY, `=x,t=${NOW},v1=${sig}`, SECRET, 300, NOW))).toBe(
      "malformed_header",
    );
    expect(reason(() => verifySignature(BODY, "x".repeat(9000), SECRET, 300, NOW))).toBe(
      "malformed_header",
    );
  });

  it("rejects a signature made with another secret, and a tampered body", () => {
    const header = `t=${NOW},v1=${hmac(NOW, BODY, "whsec_attacker")}`;
    expect(reason(() => verifySignature(BODY, header, SECRET, 300, NOW))).toBe(
      "signature_mismatch",
    );
    const good = `t=${NOW},v1=${hmac(NOW, BODY, SECRET)}`;
    expect(
      reason(() => verifySignature(BODY.replace("active", "canceled"), good, SECRET, 300, NOW)),
    ).toBe("signature_mismatch");
    expect(reason(() => verifySignature(`${BODY} `, good, SECRET, 300, NOW))).toBe(
      "signature_mismatch",
    );
  });

  it("binds the timestamp: changing t invalidates the signature", () => {
    const sig = hmac(NOW - 1000, BODY, SECRET);
    expect(reason(() => verifySignature(BODY, `t=${NOW},v1=${sig}`, SECRET, 300, NOW))).toBe(
      "signature_mismatch",
    );
  });

  it("enforces the tolerance window in both directions (300 s inclusive)", () => {
    const at = (t: number) => `t=${t},v1=${hmac(t, BODY, SECRET)}`;
    expect(() => verifySignature(BODY, at(NOW - 300), SECRET, 300, NOW)).not.toThrow();
    expect(() => verifySignature(BODY, at(NOW + 300), SECRET, 300, NOW)).not.toThrow();
    expect(reason(() => verifySignature(BODY, at(NOW - 301), SECRET, 300, NOW))).toBe(
      "timestamp_outside_tolerance",
    );
    expect(reason(() => verifySignature(BODY, at(NOW + 301), SECRET, 300, NOW))).toBe(
      "timestamp_outside_tolerance",
    );
  });

  it("a captured request replayed after the window is rejected", () => {
    const header = `t=${NOW},v1=${hmac(NOW, BODY, SECRET)}`;
    expect(() => verifySignature(BODY, header, SECRET, 300, NOW + 10)).not.toThrow();
    expect(reason(() => verifySignature(BODY, header, SECRET, 300, NOW + 3600))).toBe(
      "timestamp_outside_tolerance",
    );
  });

  it("accepts when any of several v1 signatures matches (secret roll) and ignores v0 and debug entries", () => {
    const header = [
      `t=${NOW}`,
      `v1=${hmac(NOW, BODY, OLD_SECRET)}`,
      `v1=${hmac(NOW, BODY, SECRET)}`,
      `v0=${hmac(NOW, BODY, "whsec_other")}`,
      "secret=whsec_****Vt",
      "destination=we_123",
      "payload=a25aefc6",
    ].join(",");
    expect(() => verifySignature(BODY, header, SECRET, 300, NOW)).not.toThrow();
    expect(() => verifySignature(BODY, header, OLD_SECRET, 300, NOW)).not.toThrow();
    // Order is not significant.
    const reordered = header.split(",").reverse().join(",");
    expect(() => verifySignature(BODY, reordered, SECRET, 300, NOW)).not.toThrow();
  });

  it("a v0 signature alone is never accepted (downgrade)", () => {
    const header = `t=${NOW},v0=${hmac(NOW, BODY, SECRET)}`;
    expect(reason(() => verifySignature(BODY, header, SECRET, 300, NOW))).toBe("no_signatures");
  });

  it("accepts a list of secrets (old and new) while rolling", () => {
    const header = `t=${NOW},v1=${hmac(NOW, BODY, OLD_SECRET)}`;
    expect(() => verifySignature(BODY, header, [SECRET, OLD_SECRET], 300, NOW)).not.toThrow();
    expect(reason(() => verifySignature(BODY, header, [SECRET], 300, NOW))).toBe(
      "signature_mismatch",
    );
  });

  it("refuses an empty secret (an empty HMAC key would be forgeable) and a zero tolerance", () => {
    const header = `t=${NOW},v1=${hmac(NOW, BODY, "")}`;
    expect(reason(() => verifySignature(BODY, header, "", 300, NOW))).toBe("no_secret");
    expect(reason(() => verifySignature(BODY, header, [], 300, NOW))).toBe("no_secret");
    expect(() =>
      verifySignature(BODY, `t=${NOW},v1=${hmac(NOW, BODY, SECRET)}`, SECRET, 0, NOW),
    ).toThrow(RangeError);
  });

  it("caps the number of v1 entries considered", () => {
    const junk = Array.from({ length: 40 }, (_, i) => `v1=${hmac(NOW, BODY, `whsec_junk${i}`)}`);
    const header = [`t=${NOW}`, ...junk, `v1=${hmac(NOW, BODY, SECRET)}`].join(",");
    expect(reason(() => verifySignature(BODY, header, SECRET, 300, NOW))).toBe(
      "signature_mismatch",
    );
    expect(parseSignatureHeader(header).v1).toHaveLength(16);
  });

  it("works on bytes as well as strings (UTF-8)", () => {
    const body = BODY.replace("cus_1", "cus_ü");
    const header = `t=${NOW},v1=${hmac(NOW, body, SECRET)}`;
    expect(() =>
      verifySignature(Buffer.from(body, "utf8"), header, SECRET, 300, NOW),
    ).not.toThrow();
  });
});

describe("compatibility with the official stripe library (local helpers only, no network)", () => {
  const sdk = new Stripe("sk_test_not_a_real_key_used_offline");

  it("accepts headers produced by stripe.webhooks.generateTestHeaderString", () => {
    const header = sdk.webhooks.generateTestHeaderString({
      payload: BODY,
      secret: SECRET,
      timestamp: NOW,
    });
    expect(() => verifySignature(BODY, header, SECRET, 300, NOW)).not.toThrow();
    const wrong = sdk.webhooks.generateTestHeaderString({
      payload: BODY,
      secret: "whsec_wrong",
      timestamp: NOW,
    });
    expect(reason(() => verifySignature(BODY, wrong, SECRET, 300, NOW))).toBe("signature_mismatch");
  });

  it("the SDK accepts headers produced by our signPayload", () => {
    const now = Math.floor(Date.now() / 1000);
    const event = sdk.webhooks.constructEvent(BODY, signPayload(BODY, SECRET, now), SECRET, 300);
    expect(event.id).toBe("evt_123");
  });
});

describe("event body parsing", () => {
  it("extracts id, type, created, livemode and the object id", () => {
    const header = signPayload(BODY, SECRET, NOW);
    expect(constructEvent(BODY, header, SECRET, 300, NOW)).toMatchObject({
      id: "evt_123",
      type: "customer.subscription.updated",
      created: NOW - 5,
      livemode: false,
      objectId: "sub_123",
    });
  });

  it("rejects a signed but malformed event", () => {
    for (const body of [
      "not json",
      "[]",
      "{}",
      JSON.stringify({ id: "evt_1", type: "x", created: 1, livemode: false }),
    ]) {
      expect(reason(() => parseEventBody(body))).toBe("malformed_event");
    }
    const badId = JSON.stringify({
      id: "x",
      type: "a.b",
      created: 1,
      livemode: false,
      data: { object: { id: "o" } },
    });
    expect(reason(() => parseEventBody(badId))).toBe("malformed_event");
  });
});
