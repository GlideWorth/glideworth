import { describe, expect, it } from "vitest";
import { type SessionState, sessionAfterUnauthorized } from "../src/lib/auth";

describe("the session state after an API call answers 401", () => {
  it("self-hosted: shows the passphrase sign-in screen", () => {
    expect(sessionAfterUnauthorized({ kind: "authenticated", via: "session" })).toEqual({
      kind: "login",
    });
  });

  it("hosted, signed in: goes to the hosted sign-in screens, never the passphrase screen", () => {
    const signedIn = { kind: "authenticated", cloud: {} } as unknown as SessionState;
    expect(sessionAfterUnauthorized(signedIn)).toEqual({ kind: "cloud-signed-out" });
  });

  it("hosted, already signed out (a deep link opened signed out): keeps the state, with its bot-check key", () => {
    const signedOut: SessionState = {
      kind: "cloud-signed-out",
      captchaSiteKey: "k",
      googleSignIn: true,
    };
    expect(sessionAfterUnauthorized(signedOut)).toBe(signedOut);
  });
});
