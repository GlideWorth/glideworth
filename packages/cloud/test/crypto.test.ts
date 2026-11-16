import { randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveKey, keyring, SealedValueError } from "../src/crypto/keyring.js";
import {
  base32Decode,
  base32Encode,
  newAccountId,
  newUserId,
  safeEqual,
  USER_ID_RE,
} from "../src/crypto/random.js";
import { API_KEY_RE, mintApiKey, mintRouted, parseRouted } from "../src/crypto/routed.js";
import { Semaphore, SemaphoreFullError } from "../src/crypto/semaphore.js";
import {
  hotp,
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
  otpauthUri,
  RECOVERY_CODE_RE,
  totpStep,
  verifyTotp,
} from "../src/crypto/totp.js";
import { CloudError } from "../src/errors.js";
import {
  assertPasswordPolicy,
  DUMMY_HASH,
  hashPassword,
  needsRehash,
  scryptGate,
  verifyPassword,
} from "../src/password.js";
import { remember } from "./helpers.js";

describe("base32 (RFC 4648 section 10)", () => {
  const vectors: Array<[string, string]> = [
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ];
  it.each(vectors)("%s <-> %s", (plain, enc) => {
    expect(base32Encode(Buffer.from(plain), true)).toBe(enc);
    expect(Buffer.from(base32Decode(`${enc}===`) as Uint8Array).toString()).toBe(plain);
    expect(Buffer.from(base32Decode(enc.toLowerCase()) as Uint8Array).toString()).toBe(plain);
  });
  it("rejects characters outside the alphabet", () => {
    expect(base32Decode("MZ1W")).toBeNull();
    expect(base32Decode("../")).toBeNull();
  });
});

describe("TOTP (RFC 6238 appendix B)", () => {
  const seed1 = Buffer.from("12345678901234567890");
  const seed256 = Buffer.from("12345678901234567890123456789012");
  const seed512 = Buffer.from("1234567890123456789012345678901234567890123456789012345678901234");
  const table: Array<[number, string, string, string]> = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];
  it.each(table)("T=%i", (t, sha1, sha256, sha512) => {
    const step = totpStep(t * 1000);
    expect(hotp(seed1, step, { digits: 8, algorithm: "sha1" })).toBe(sha1);
    expect(hotp(seed256, step, { digits: 8, algorithm: "sha256" })).toBe(sha256);
    expect(hotp(seed512, step, { digits: 8, algorithm: "sha512" })).toBe(sha512);
    // The 6-digit code of the enrolment parameters is the same truncation mod 10^6.
    const secret = base32Encode(seed1, true);
    expect(verifyTotp(secret, sha1.slice(2), t * 1000, null)).toBe(step);
  });

  const secret = base32Encode(seed1, true);
  const t = 1111111111 * 1000;
  const step = totpStep(t);
  const code = (s: number) => hotp(seed1, s);

  it("accepts one step either side and nothing further", () => {
    expect(verifyTotp(secret, code(step - 1), t, null)).toBe(step - 1);
    expect(verifyTotp(secret, code(step + 1), t, null)).toBe(step + 1);
    expect(verifyTotp(secret, code(step - 2), t, null)).toBeNull();
    expect(verifyTotp(secret, code(step + 2), t, null)).toBeNull();
  });
  it("refuses replay of a used step, and of any earlier step", () => {
    expect(verifyTotp(secret, code(step), t, step)).toBeNull();
    expect(verifyTotp(secret, code(step - 1), t, step)).toBeNull();
    expect(verifyTotp(secret, code(step + 1), t, step)).toBe(step + 1);
  });
  it("refuses malformed codes", () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12345a", "١٢٣٤٥٦"])
      expect(verifyTotp(secret, bad, t, null)).toBeNull();
    expect(verifyTotp(secret, ` ${code(step).slice(0, 3)} ${code(step).slice(3)} `, t, null)).toBe(
      step,
    );
  });
  it("enrolment secret and otpauth URI", () => {
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)?.length).toBe(20);
    const uri = new URL(otpauthUri(s, "a+b@example.org"));
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.searchParams.get("secret")).toBe(s);
    expect(uri.searchParams.get("issuer")).toBe("Glideworth");
    expect(uri.searchParams.get("digits")).toBe("6");
    expect(uri.searchParams.get("period")).toBe("30");
    expect(uri.searchParams.get("algorithm")).toBe("SHA1");
  });
});

describe("recovery codes", () => {
  it("10 codes of xxxxx-xxxxx base32, distinct", () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(RECOVERY_CODE_RE);
    expect(new Set(codes).size).toBe(10);
  });
  it("normalises typing variations and rejects anything else", () => {
    expect(normalizeRecoveryCode(" ABCDE-FGH23 ")).toBe("abcde-fgh23");
    expect(normalizeRecoveryCode("abcdefgh23")).toBe("abcde-fgh23");
    expect(normalizeRecoveryCode("abcde-fgh21")).toBeNull(); // 1 is not base32
    expect(normalizeRecoveryCode("abcde")).toBeNull();
    expect(normalizeRecoveryCode("x".repeat(100))).toBeNull();
  });
});

describe("keyring", () => {
  const k = keyring(randomBytes(32));
  it("round-trips sealed values", () => {
    const plain = Buffer.from("JBSWY3DPEHPK3PXP");
    const sealed = k.seal("totp", plain);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("JBSWY3DP");
    expect(Buffer.from(k.open("totp", sealed)).toString()).toBe("JBSWY3DPEHPK3PXP");
    expect(k.seal("totp", plain)).not.toBe(sealed); // random nonce
  });
  it("detects tampering anywhere in the sealed value", () => {
    const sealed = k.seal("totp", Buffer.from("secret value"));
    const raw = Buffer.from(sealed.slice(3), "base64url");
    for (let i = 0; i < raw.length; i++) {
      const t = Buffer.from(raw);
      t[i] = (t[i] as number) ^ 1;
      expect(() => k.open("totp", `v1.${t.toString("base64url")}`)).toThrow(SealedValueError);
    }
    expect(() =>
      k.open("totp", `v1.${raw.subarray(0, raw.length - 1).toString("base64url")}`),
    ).toThrow(SealedValueError);
    expect(() => k.open("totp", "v2.abc")).toThrow(SealedValueError);
    expect(() => k.open("totp", "")).toThrow(SealedValueError);
  });
  it("separates purposes and keys", () => {
    const sealed = k.seal("totp", Buffer.from("x"));
    expect(() => k.open("operator-totp", sealed)).toThrow(SealedValueError);
    expect(() => keyring(randomBytes(32)).open("totp", sealed)).toThrow(SealedValueError);
    expect(k.hmac("device", "abc")).not.toBe(k.hmac("recovery-code", "abc"));
    expect(k.hmac("device", "abc")).toBe(k.hmac("device", "abc"));
    expect(k.hmac("device", "abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(keyring(randomBytes(32)).hmac("device", "abc")).not.toBe(k.hmac("device", "abc"));
  });
  it("refuses bad keys and purposes", () => {
    expect(() => keyring(randomBytes(31))).toThrow();
    expect(() => k.hmac("../x", "a")).toThrow();
    expect(() => k.seal("", Buffer.from("a"))).toThrow();
    expect(deriveKey(new Uint8Array(32), "unsubscribe")).toHaveLength(32);
  });
});

describe("passwords", () => {
  it("produces the apps/api format and parameters", async () => {
    const pw = remember("correct horse battery staple");
    const h = await hashPassword(pw);
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/);
    expect(await verifyPassword(pw, h)).toBe(true);
    expect(await verifyPassword(`${pw}x`, h)).toBe(false);
    expect(needsRehash(h)).toBe(false);
  });
  it("verifies a hash computed the way apps/api computes it (byte compatibility, NFKC)", async () => {
    const pw = remember("ﬁnancial planning pass"); // U+FB01 ligature: NFKC turns it into "fi"
    const salt = randomBytes(16);
    const key = scryptSync(pw.normalize("NFKC"), salt, 32, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 128 * 32768 * 8 + 1024 * 1024,
    });
    const stored = `scrypt$32768$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
    expect(await verifyPassword(pw, stored)).toBe(true);
    expect(await verifyPassword("financial planning pass", stored)).toBe(true);
  });
  it("upgrades other parameters and refuses malformed or hostile stored hashes", async () => {
    const salt = randomBytes(16);
    const weak = `scrypt$16384$8$1$${salt.toString("base64")}$${scryptSync("pw-weak-params!", salt, 32, { N: 16384, r: 8, p: 1 }).toString("base64")}`;
    expect(await verifyPassword("pw-weak-params!", weak)).toBe(true);
    expect(needsRehash(weak)).toBe(true);
    for (const bad of [
      "",
      "bcrypt$x",
      "scrypt$1048577$8$1$AA==$AA==",
      `scrypt$${2 ** 24}$8$1$AA==$${"A".repeat(43)}=`,
      "scrypt$32768$8$1$AA==$AA==$x",
    ])
      expect(await verifyPassword("anything at all", bad)).toBe(false);
    expect(await verifyPassword("anything at all", DUMMY_HASH)).toBe(false);
  });
  it("bounds the input", async () => {
    await expect(hashPassword("a".repeat(1025))).rejects.toBeInstanceOf(CloudError);
    expect(await verifyPassword("a".repeat(5000), DUMMY_HASH)).toBe(false);
    // NFKC expansion: 1000 characters that become 18 each exceed the byte bound.
    expect(() =>
      assertPasswordPolicy({ password: "ﷺ".repeat(1000), email: "a@example.org" }),
    ).toThrow(CloudError);
  });
  it("policy: length bounds and the email local part", () => {
    const ok =
      (password: string, email = "jane.doe@example.org") =>
      () =>
        assertPasswordPolicy({ password, email });
    expect(ok("twelve chars")).not.toThrow();
    expect(ok("elevenchars")).toThrow(/at least 12/);
    expect(ok("a".repeat(1024))).not.toThrow();
    expect(ok("a".repeat(1025))).toThrow(/at most 1024/);
    expect(ok("JANE.DOE@example.org")).toThrow(/email/);
    expect(ok("my jane.doe password")).toThrow(/email/);
    expect(ok("bob", "bob@example.org")).toThrow();
    expect(ok("bobsled racing team", "bob@example.org")).not.toThrow(); // short local parts are not "contained"
    try {
      ok("my jane.doe password")();
    } catch (e) {
      expect((e as CloudError).code).toBe("WEAK_PASSWORD");
      expect((e as Error).message).not.toContain("jane");
    }
  });
  it("never runs more than 4 scrypt computations at once", async () => {
    scryptGate.resetPeak();
    const hashes = await Promise.all(
      Array.from({ length: 12 }, (_, i) => hashPassword(`parallel password ${i}`)),
    );
    expect(hashes).toHaveLength(12);
    expect(scryptGate.stats().peak).toBeLessThanOrEqual(4);
    expect(scryptGate.stats().peak).toBe(4);
    expect(scryptGate.stats().active).toBe(0);
  });
});

describe("semaphore", () => {
  it("bounds concurrency and the queue", async () => {
    const s = new Semaphore(2, 1);
    const a = await s.acquire();
    const b = await s.acquire();
    const c = s.acquire();
    await expect(s.acquire()).rejects.toBeInstanceOf(SemaphoreFullError);
    a();
    a(); // double release is a no-op
    const rc = await c;
    expect(s.stats()).toMatchObject({ active: 2, waiting: 0, peak: 2 });
    b();
    rc();
    expect(s.stats().active).toBe(0);
  });
});

describe("ids and routed credentials", () => {
  it("ids have the specified shapes", () => {
    expect(newAccountId()).toMatch(/^t[a-z2-7]{15}$/);
    expect(newUserId()).toMatch(USER_ID_RE);
  });
  it("round-trips every kind", () => {
    const acct = newAccountId();
    for (const kind of ["oauth_access", "oauth_refresh", "oauth_code", "share"] as const) {
      const t = mintRouted(kind, acct);
      expect(t).toMatch(/^gw[arcs]_t[a-z2-7]{15}_[a-z2-7]{52}$/);
      expect(parseRouted(t)).toEqual({ kind, accountId: acct });
    }
    const { key, prefix } = mintApiKey(acct);
    expect(key).toMatch(API_KEY_RE);
    expect(prefix).toMatch(/^[a-z2-7]{8}$/);
    expect(key.split("_")[2]).toBe(prefix);
    expect(parseRouted(key)).toEqual({ kind: "key", accountId: acct });
  });
  it("refuses malformed and crafted tokens", () => {
    const acct = newAccountId();
    const good = mintRouted("share", acct);
    const secret = good.slice(21);
    const crafted = [
      "",
      "gws_",
      `gws_../../etc/passwd_${secret}`,
      `gws_t../../../../xx_${secret}`,
      `gws_t${"a".repeat(14)}_${secret}`, // 15 chars
      `gws_t${"a".repeat(16)}_${secret}`, // 17 chars
      `gws_${acct.toUpperCase()}_${secret}`,
      `GWS_${acct}_${secret}`,
      `gws_${acct}_${secret.toUpperCase()}`,
      `gws_${acct}_${secret.slice(0, 31)}`,
      `gws_${acct}_${secret}\n`,
      `gws_${acct}_${secret}/..`,
      `gwx_${acct}_${secret}`,
      `gwk_${acct}_${secret}`, // API key without its prefix part
      `gws_u${acct.slice(1)}_${secret}`,
      `gws_t${"1".repeat(15)}_${secret}`, // 1 is not base32
      `gws_${acct}_${"a".repeat(300)}`,
      `gws_${acct}%2f_${secret}`,
    ];
    for (const t of crafted) expect(parseRouted(t)).toBeNull();
    expect(parseRouted(undefined as unknown as string)).toBeNull();
    expect(() => mintRouted("share", "../x")).toThrow();
    expect(() => mintApiKey("T".repeat(16))).toThrow();
  });
  it("constant-time equality helper", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
