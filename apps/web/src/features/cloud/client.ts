/**
 * Typed client for the hosted ("cloud") API: the routes in packages/cloud/src/http/routes/*.ts.
 * Browser session cookie (sent automatically, same origin) plus the CSRF header on every write
 * (`X-CSRF-Token` = the readable `__Host-gw_csrf` cookie, see lib/auth.ts `csrfHeaders`). Nothing here
 * stores a secret: passwords and codes go straight into a request body.
 *
 * Errors are `ApiRequestError` (status, code, message, details) like the rest of the app, so the shell
 * reacts to 402 / 429 the same way. `REAUTH_REQUIRED` is handled once, by `withReauth` (reauth.ts).
 */
import { z } from "zod";
import { ApiRequestError } from "../../lib/api-error";
import { reportApiProblem } from "../../lib/api-problems";
import { csrfHeaders } from "../../lib/auth";

const Role = z.enum(["owner", "editor", "viewer"]);
export type InviteRole = "editor" | "viewer";

const ErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

async function send(method: string, path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...csrfHeaders(method),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiRequestError(
      0,
      "NETWORK",
      "Glideworth could not be reached. Check your connection and try again.",
    );
  }
  const json: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const e = ErrorBody.safeParse(json);
    if (e.success) reportApiProblem(res.status, e.data.error.code, e.data.error.details);
    throw new ApiRequestError(
      res.status,
      e.success ? e.data.error.code : "HTTP",
      e.success ? e.data.error.message : `Request failed (HTTP ${res.status}).`,
      e.success ? e.data.error.details : undefined,
    );
  }
  return json;
}

async function call<S extends z.ZodType>(
  method: string,
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await send(method, path, body));
  if (!parsed.success)
    throw new ApiRequestError(200, "BAD_RESPONSE", "The server sent an unexpected answer.");
  return parsed.data;
}

/** A request whose success carries no body (204). */
async function callVoid(method: string, path: string, body?: unknown): Promise<void> {
  await send(method, path, body);
}

const Ok = z.object({ status: z.literal("ok") }).passthrough();
const CheckEmail = z.object({ status: z.literal("check-email") });
const SignedIn = z.object({
  status: z.enum(["signed-in", "totp-required"]),
  challenge: z.string().optional(),
  expiresAt: z.string().optional(),
  redirectTo: z.string().optional(),
  csrfToken: z.string().optional(),
});
const Items = <T extends z.ZodType>(t: T) => z.object({ items: z.array(t) });

// ------------------------------------------------------------------------------------------ account
const Profile = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  emailVerifiedAt: z.string().nullish(),
  twoFactorEnabled: z.boolean().nullish(),
  signinAlerts: z.boolean().nullish(),
  checkinEmails: z.boolean().nullish(),
  /** Sign-in methods: false for an account created with Google that has not set a password. */
  passwordSet: z.boolean().optional(),
  identities: z
    .array(
      z.object({
        provider: z.string(),
        email: z.string().nullish(),
        linkedAt: z.string(),
        lastUsedAt: z.string().nullish(),
      }),
    )
    .optional(),
  googleSignIn: z.boolean().optional(),
});
type Profile = z.infer<typeof Profile>;
const SessionRow = z.object({
  id: z.string(),
  device: z.string().nullish(),
  ip: z.string().nullish(),
  createdAt: z.string().nullish(),
  lastSeenAt: z.string().nullish(),
  current: z.boolean().optional(),
});
export type SessionRow = z.infer<typeof SessionRow>;
const Codes = z.object({ recoveryCodes: z.array(z.string()) });

// ---------------------------------------------------------------------------------------- workspace
const WorkspaceSettings = z.object({
  id: z.string(),
  name: z.string(),
  mcpWrites: z.boolean().optional(),
  status: z.string().nullish(),
  role: Role,
  limits: z.object({ editors: z.number(), viewers: z.number() }).passthrough().optional(),
});
type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;
const Member = z.object({
  userId: z.string(),
  role: Role,
  name: z.string(),
  /** Sent to owners and editors only; viewers see names. */
  email: z.string().optional(),
});
export type Member = z.infer<typeof Member>;
const Invitation = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(["editor", "viewer"]),
  expiresAt: z.string().nullish(),
});
export type Invitation = z.infer<typeof Invitation>;
const SupportGrant = z.object({
  id: z.string(),
  reason: z.string().nullish(),
  expiresAt: z.string(),
  revokedAt: z.string().nullish(),
  createdAt: z.string().nullish(),
});
type SupportGrant = z.infer<typeof SupportGrant>;

// ---------------------------------------------------------------------------------------------- billing
const Offered = z.object({
  lookupKey: z.string(),
  interval: z.enum(["month", "year"]),
  product: z.string().nullish(),
  /** From the pricing file: minor units, lowercase ISO currency and tax behaviour of the price. */
  unitAmount: z.number(),
  currency: z.string(),
  taxBehavior: z.enum(["inclusive", "exclusive"]),
});
export type OfferedPrice = z.infer<typeof Offered>;
const Billing = z.object({
  status: z.string().nullable(),
  plan: z.string().nullish(),
  lookupKey: z.string().nullish(),
  interval: z.enum(["month", "year"]).nullish(),
  trialEndsAt: z.string().nullish(),
  currentPeriodEnd: z.string().nullish(),
  cancelAtPeriodEnd: z.boolean().optional(),
  access: z.object({
    level: z.enum(["full", "read_only", "suspended"]),
    reason: z.string(),
    changesAt: z.string().nullish(),
  }),
  role: Role.optional(),
  offered: z.array(Offered).optional(),
});
export type BillingInfo = z.infer<typeof Billing>;

const enc = encodeURIComponent;

export const cloudApi = {
  // auth
  signUp: (b: {
    email: string;
    password: string;
    name: string;
    termsVersion: string;
    adultConfirmed: boolean;
    captchaToken?: string;
    /** The invitation this sign-up started from: confirming the address then leads back to it. */
    invitation?: string;
  }) => call("POST", "/api/v1/auth/signup", CheckEmail, b),
  /** `password` (and a CAPTCHA once asked) only after the server answered `PASSWORD_REQUIRED`. */
  verifyEmail: (token: string, proof: { password?: string; captchaToken?: string } = {}) =>
    call("POST", "/api/v1/auth/verify", SignedIn, {
      token,
      ...(proof.password ? { password: proof.password } : {}),
      ...(proof.captchaToken ? { captchaToken: proof.captchaToken } : {}),
    }),
  resendVerification: (email: string) =>
    call("POST", "/api/v1/auth/resend-verification", CheckEmail, { email }),
  signIn: (b: { email: string; password: string; captchaToken?: string; next?: string }) =>
    call("POST", "/api/v1/auth/signin", SignedIn, b),
  signInTotp: (b: { challenge: string; code?: string; recoveryCode?: string; next?: string }) =>
    call("POST", "/api/v1/auth/signin/totp", SignedIn, b),
  signOut: () => callVoid("POST", "/api/v1/auth/signout"),
  reauth: (b: { password?: string; totpCode?: string }) =>
    call("POST", "/api/v1/auth/reauth", z.object({ status: z.literal("ok") }).passthrough(), b),
  forgotPassword: (email: string, captchaToken?: string) =>
    call("POST", "/api/v1/auth/password/forgot", CheckEmail, {
      email,
      ...(captchaToken ? { captchaToken } : {}),
    }),
  resetPassword: (token: string, password: string) =>
    call("POST", "/api/v1/auth/password/reset", SignedIn, { token, password }),
  // "Sign in with Google": the button itself is a plain link (googleStartPath), not a request.
  googlePending: () =>
    call(
      "GET",
      "/api/v1/auth/google/pending",
      z.object({
        name: z.string(),
        email: z.string(),
        /** The workspace of the invitation this sign-up started from, while it can be accepted. */
        invitedTo: z.string().nullable().optional(),
      }),
    ),
  googleComplete: (b: { name: string; termsVersion: string; adultConfirmed: true }) =>
    call("POST", "/api/v1/auth/google/complete", SignedIn, b),

  // account
  profile: () => call("GET", "/api/v1/account/profile", Profile),
  updateProfile: (b: { name?: string; signinAlerts?: boolean; checkinEmails?: boolean }) =>
    call("PATCH", "/api/v1/account/profile", Ok, b),
  changeEmail: (email: string) => call("POST", "/api/v1/account/email", CheckEmail, { email }),
  confirmEmail: (token: string) => call("POST", "/api/v1/account/email/confirm", Ok, { token }),
  changePassword: (current: string, next: string) =>
    call("POST", "/api/v1/account/password", Ok, { current, next }),
  sessions: () => call("GET", "/api/v1/account/sessions", Items(SessionRow)),
  revokeSession: (id: string) => callVoid("DELETE", `/api/v1/account/sessions/${enc(id)}`),
  revokeOtherSessions: () =>
    call(
      "POST",
      "/api/v1/account/sessions/revoke-others",
      z.object({ revoked: z.number() }).passthrough(),
    ),
  totpBegin: () =>
    call(
      "POST",
      "/api/v1/account/totp/begin",
      z.object({ secret: z.string(), otpauthUri: z.string() }),
    ),
  totpConfirm: (code: string) => call("POST", "/api/v1/account/totp/confirm", Codes, { code }),
  totpDisable: (code: string) => callVoid("DELETE", "/api/v1/account/totp", { code }),
  regenerateRecoveryCodes: () => call("POST", "/api/v1/account/recovery-codes", Codes),
  personalData: () => call("GET", "/api/v1/account/personal-data", z.unknown()),
  deleteAccount: () => callVoid("DELETE", "/api/v1/account"),
  passwordSetup: () => call("POST", "/api/v1/account/password/setup", CheckEmail),
  linkGoogle: () =>
    call("POST", "/api/v1/account/identities/google", z.object({ url: z.string() })),
  unlinkGoogle: () => callVoid("DELETE", "/api/v1/account/identities/google"),
  /** Finish the link Google's redirect parked for this browser (`/google-link`): "linked", or why not. */
  finishGoogleLink: () =>
    call("POST", "/api/v1/account/identities/google/finish", z.object({ google: z.string() })),

  // workspaces
  workspaceSettings: () => call("GET", "/api/v1/workspace/settings", WorkspaceSettings),
  updateWorkspace: (b: { name?: string; mcpWrites?: boolean }) =>
    call("PATCH", "/api/v1/workspace/settings", Ok, b),
  activateWorkspace: (id: string) => callVoid("POST", `/api/v1/workspaces/${enc(id)}/activate`),
  /** One per person; the server switches to it. */
  createWorkspace: (name: string) => callVoid("POST", "/api/v1/workspaces", { name }),
  members: () => call("GET", "/api/v1/workspace/members", Items(Member)),
  changeRole: (userId: string, role: InviteRole) =>
    callVoid("PATCH", `/api/v1/workspace/members/${enc(userId)}`, { role }),
  removeMember: (userId: string) => callVoid("DELETE", `/api/v1/workspace/members/${enc(userId)}`),
  invitations: () => call("GET", "/api/v1/workspace/invitations", Items(Invitation)),
  invite: (email: string, role: InviteRole) =>
    call("POST", "/api/v1/workspace/invitations", z.object({ id: z.string() }).passthrough(), {
      email,
      role,
    }),
  resendInvitation: (id: string) =>
    call(
      "POST",
      `/api/v1/workspace/invitations/${enc(id)}/resend`,
      z.object({ id: z.string() }).passthrough(),
      {},
    ),
  revokeInvitation: (id: string) => callVoid("DELETE", `/api/v1/workspace/invitations/${enc(id)}`),
  /** What an invitation offers (no sign-in needed). `INVALID_TOKEN` for any token that cannot be accepted. */
  previewInvitation: (token: string) =>
    call(
      "POST",
      "/api/v1/workspace/invitations/preview",
      z.object({ workspaceName: z.string(), role: z.enum(["editor", "viewer"]) }),
      { token },
    ),
  acceptInvitation: (token: string) =>
    call(
      "POST",
      "/api/v1/workspace/invitations/accept",
      z.object({ workspaceId: z.string() }).passthrough(),
      { token },
    ),
  transferOwnership: (userId: string) => callVoid("POST", "/api/v1/workspace/transfer", { userId }),
  leaveWorkspace: () => callVoid("POST", "/api/v1/workspace/leave"),
  exportWorkspace: () =>
    call(
      "POST",
      "/api/v1/workspace/export",
      z.object({ exportId: z.string(), expiresAt: z.string() }),
    ),
  /** Whether an export can still be downloaded; does not use the download up. */
  exportStatus: (exportId: string) =>
    call(
      "GET",
      `/api/v1/workspace/exports/${enc(exportId)}/status`,
      z.object({
        status: z.enum(["ready", "downloaded", "expired"]),
        expiresAt: z.string().nullable(),
      }),
    ),
  supportGrants: () => call("GET", "/api/v1/workspace/support-grants", Items(SupportGrant)),
  createSupportGrant: (reason: string, days: number) =>
    call(
      "POST",
      "/api/v1/workspace/support-grants",
      z.object({ id: z.string(), expiresAt: z.string() }),
      { reason, days },
    ),
  revokeSupportGrant: (id: string) =>
    callVoid("DELETE", `/api/v1/workspace/support-grants/${enc(id)}`),
  deleteWorkspace: (confirmName: string) =>
    callVoid("DELETE", "/api/v1/workspace", { confirmName }),

  // billing
  billing: () => call("GET", "/api/v1/billing", Billing),
  checkout: (lookupKey: string) =>
    call(
      "POST",
      "/api/v1/billing/checkout",
      z.object({ url: z.string(), reused: z.boolean().optional() }),
      { lookupKey },
    ),
  portal: () => call("POST", "/api/v1/billing/portal", z.object({ url: z.string() })),
};

/** Where the one-time workspace export is downloaded (a plain link: single use, streamed by the server). */
export const exportDownloadPath = (exportId: string) =>
  `/api/v1/workspace/exports/${enc(exportId)}`;

/**
 * "Continue with Google": a top-level navigation to the server, which redirects to Google. `invitation` is
 * the token of the invitation held in this tab: the server keeps it with the flow and the person ends on
 * that invitation, as after an email sign-up.
 */
export const googleStartPath = (next: string, invitation?: string | null) => {
  const q = new URLSearchParams();
  if (next && next !== "/") q.set("next", next);
  if (invitation) q.set("invitation", invitation);
  const s = q.toString();
  return `/api/v1/auth/google/start${s ? `?${s}` : ""}`;
};
