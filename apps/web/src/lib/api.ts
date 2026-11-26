/**
 * Typed API client. Response bodies are validated with the SAME Zod schemas the API uses
 * (@glideworth/core), so the client can never silently drift from the server contract.
 * In dev the Vite server proxies /api and injects the API key server-side.
 */
import {
  CurrentFinances,
  FxRate,
  type FxRateInput,
  GlideworthDocument,
  Household,
  type HouseholdInput,
  Plan,
  type PlanInput,
  ProgressSnapshot,
  type ProgressSnapshotInput,
  ProjectionResult,
  ResultChange,
  ResultChangeUnavailable,
  type SimulationOptionsInput,
  UserSettings,
  type UserSettingsInput,
} from "@glideworth/core";
import { z } from "zod";
import { ApiRequestError } from "./api-error";
import { reportApiProblem } from "./api-problems";
import { csrfHeaders } from "./auth";

export { ApiRequestError, isMissingRoute } from "./api-error";

/** The answer of POST /snapshots/history (only the fields the web app reads are checked). */
const BalanceHistoryResult = z.looseObject({
  applied: z.boolean(),
  blocked: z.boolean(),
  counts: z.object({
    added: z.number(),
    updated: z.number(),
    removed: z.number(),
    unchanged: z.number(),
    snapshotsCreated: z.number(),
    snapshotsUpdated: z.number(),
    snapshotsRemoved: z.number(),
  }),
  currentBalances: z
    .object({ accounts: z.number(), realAssets: z.number(), debts: z.number() })
    .nullable(),
});

const ErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

export interface ApiClientOptions {
  baseUrl?: string;
  /** Only for non-proxied deployments; the dev proxy injects the key itself. */
  apiKey?: string;
  fetch?: typeof fetch;
}

export function createApiClient(opts: ApiClientOptions = {}) {
  const base = opts.baseUrl ?? "";
  const f = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function request<S extends z.ZodType>(
    method: string,
    path: string,
    schema: S,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<z.infer<S>> {
    const res = await f(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        ...csrfHeaders(method),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const e = ErrorBody.safeParse(json);
      if (e.success) reportApiProblem(res.status, e.data.error.code, e.data.error.details);
      throw new ApiRequestError(
        res.status,
        e.success ? e.data.error.code : "HTTP",
        e.success ? e.data.error.message : res.statusText,
        e.success ? e.data.error.details : undefined,
      );
    }
    return schema.parse(json);
  }

  return {
    health: () =>
      request(
        "GET",
        "/health",
        z.object({ status: z.string(), engineVersion: z.string(), schemaVersion: z.number() }),
      ),
    listHouseholds: () =>
      request("GET", "/api/v1/households", z.object({ items: z.array(Household) })),
    getDocument: (householdId: string) =>
      request(
        "GET",
        `/api/v1/households/${encodeURIComponent(householdId)}/document`,
        GlideworthDocument,
      ),
    listPlans: (householdId?: string) =>
      request(
        "GET",
        `/api/v1/plans${householdId ? `?householdId=${encodeURIComponent(householdId)}` : ""}`,
        z.object({ items: z.array(Plan) }),
      ),
    getPlan: (id: string) => request("GET", `/api/v1/plans/${encodeURIComponent(id)}`, Plan),
    createPlan: (plan: Omit<PlanInput, "id"> & { id?: string }) =>
      request("POST", "/api/v1/plans", Plan, plan),
    updatePlan: (id: string, plan: PlanInput, version: number) =>
      request("PUT", `/api/v1/plans/${encodeURIComponent(id)}`, Plan, plan, {
        "if-match": `"${version}"`,
      }),
    simulatePlan: (id: string, options: SimulationOptionsInput = {}) =>
      request(
        "POST",
        `/api/v1/plans/${encodeURIComponent(id)}/simulate`,
        ProjectionResult,
        options,
      ),
    // --- (g) editing: some of these routes land with workstream (e); callers degrade on 404/405/501.
    getHousehold: (id: string) =>
      request("GET", `/api/v1/households/${encodeURIComponent(id)}`, HouseholdRecordBody),
    replaceHousehold: (id: string, household: HouseholdInput, version?: number) =>
      request(
        "PUT",
        `/api/v1/households/${encodeURIComponent(id)}`,
        HouseholdRecordBody,
        household,
        ifMatch(version),
      ),
    /** kind: 'accounts' | 'real-assets' | 'debts'. Item bodies are Account / RealAsset / Debt. */
    createFinanceItem: (id: string, kind: FinancePath, item: unknown, version?: number) =>
      request(
        "POST",
        `/api/v1/households/${encodeURIComponent(id)}/${kind}`,
        z.unknown(),
        item,
        ifMatch(version),
      ),
    replaceFinanceItem: (
      id: string,
      kind: FinancePath,
      itemId: string,
      item: unknown,
      version?: number,
    ) =>
      request(
        "PUT",
        `/api/v1/households/${encodeURIComponent(id)}/${kind}/${encodeURIComponent(itemId)}`,
        z.unknown(),
        item,
        ifMatch(version),
      ),
    deleteFinanceItem: (id: string, kind: FinancePath, itemId: string, version?: number) =>
      request(
        "DELETE",
        `/api/v1/households/${encodeURIComponent(id)}/${kind}/${encodeURIComponent(itemId)}?force=true`,
        z.unknown(),
        undefined,
        ifMatch(version),
      ),
    /** Bulk balances; also the only way to move CurrentFinances.asOf. */
    updateBalances: (
      id: string,
      body: {
        asOf?: string;
        accounts?: unknown[];
        realAssets?: unknown[];
        debts?: unknown[];
        recordSnapshot?: boolean;
      },
      version?: number,
    ) =>
      request(
        "POST",
        `/api/v1/households/${encodeURIComponent(id)}/balances`,
        z.object({ version: z.number().int() }).passthrough(),
        { accounts: [], realAssets: [], debts: [], ...body },
        ifMatch(version),
      ),
    deletePlan: (id: string) =>
      request("DELETE", `/api/v1/plans/${encodeURIComponent(id)}?force=true`, z.unknown()),
    duplicatePlan: (id: string, name?: string) =>
      request(
        "POST",
        `/api/v1/plans/${encodeURIComponent(id)}/duplicate`,
        Plan,
        name ? { name } : {},
      ),
    planLifecycle: (id: string, action: "archive" | "unarchive" | "set-main", version?: number) =>
      request(
        "POST",
        `/api/v1/plans/${encodeURIComponent(id)}/${action}`,
        Plan,
        undefined,
        ifMatch(version),
      ),
    createBranch: (
      id: string,
      body: { name: string; description?: string; pinParentVersion?: boolean },
    ) => request("POST", `/api/v1/plans/${encodeURIComponent(id)}/branches`, Plan, body),
    /** Merge a branch back into its parent (default) or promote it to a standalone plan. */
    mergeBranch: (
      id: string,
      body: { strategy?: "into-parent" | "promote"; keepBranch?: boolean; makeMain?: boolean } = {},
    ) =>
      request(
        "POST",
        `/api/v1/plans/${encodeURIComponent(id)}/merge`,
        z.object({ plan: Plan, branchDeleted: z.boolean() }),
        body,
      ),
    restorePlanVersion: (id: string, version: number) =>
      request(
        "POST",
        `/api/v1/plans/${encodeURIComponent(id)}/versions/${version}/restore`,
        Plan,
        {},
      ),
    listPlanVersions: (id: string) =>
      request(
        "GET",
        `/api/v1/plans/${encodeURIComponent(id)}/versions`,
        z.object({
          items: z.array(
            z.object({
              version: z.number().int(),
              createdAt: z.string(),
              actor: PlanActor.nullable().optional(),
              message: z.string().nullable(),
            }),
          ),
        }),
      ),
    // --- (h) progress snapshots (routes from workstream e: /households/{id}/snapshots...).
    listSnapshots: (householdId: string) =>
      request(
        "GET",
        `/api/v1/households/${encodeURIComponent(householdId)}/snapshots?limit=200`,
        z.object({
          items: z.array(ProgressSnapshot),
          nextCursor: z.string().nullable().optional(),
          total: z.number().optional(),
        }),
      ),
    createSnapshot: (
      householdId: string,
      snap: Omit<ProgressSnapshotInput, "householdId" | "id"> & { id?: string },
    ) =>
      request(
        "POST",
        `/api/v1/households/${encodeURIComponent(householdId)}/snapshots`,
        ProgressSnapshot,
        snap,
      ),
    recordCurrentSnapshot: (householdId: string, body: { date?: string; note?: string } = {}) =>
      request(
        "POST",
        `/api/v1/households/${encodeURIComponent(householdId)}/snapshots/record`,
        z.unknown(),
        body,
      ),
    importSnapshots: (
      householdId: string,
      items: (Omit<ProgressSnapshotInput, "householdId" | "id"> & { id?: string })[],
      onConflict: "skip" | "replace" | "error" = "replace",
    ) =>
      request(
        "POST",
        `/api/v1/households/${encodeURIComponent(householdId)}/snapshots/bulk`,
        z.unknown(),
        {
          items,
          onConflict,
        },
      ),
    /** Balance-history import (see apps/api services/history.ts): dry run by default. */
    importBalanceHistory: (
      householdId: string,
      body: {
        rows: { date: string; values: Record<string, number | null>; note?: string }[];
        mode: "merge" | "replace";
        dryRun: boolean;
        updateCurrentBalances?: boolean;
        today?: string;
      },
    ) =>
      request(
        "POST",
        `/api/v1/households/${encodeURIComponent(householdId)}/snapshots/history`,
        BalanceHistoryResult,
        body,
      ),
    replaceSnapshot: (
      householdId: string,
      snapId: string,
      snap: Omit<ProgressSnapshotInput, "householdId" | "id">,
    ) =>
      request(
        "PUT",
        `/api/v1/households/${encodeURIComponent(householdId)}/snapshots/${encodeURIComponent(snapId)}`,
        ProgressSnapshot,
        snap,
      ),
    deleteSnapshot: (householdId: string, snapId: string) =>
      request(
        "DELETE",
        `/api/v1/households/${encodeURIComponent(householdId)}/snapshots/${encodeURIComponent(snapId)}`,
        z.unknown(),
      ),
    // --- (g) atomic save of the whole current-finances document (array order = display order),
    //     and persisted display order for accounts / real assets / debts / plans.
    replaceCurrentFinances: (
      householdId: string,
      body: { household?: HouseholdInput; finances: unknown },
      version?: number,
    ) =>
      request(
        "PUT",
        `/api/v1/households/${encodeURIComponent(householdId)}/current-finances`,
        HouseholdRecordBody.extend({ snapshot: ProgressSnapshot.nullable().optional() }),
        body,
        ifMatch(version),
      ),
    reorderCollection: (
      householdId: string,
      collection: "accounts" | "real-assets" | "debts" | "plans",
      ids: string[],
      version?: number,
    ) =>
      request(
        "PUT",
        `/api/v1/households/${encodeURIComponent(householdId)}/reorder/${collection}`,
        z.object({
          collection: z.string(),
          ids: z.array(z.string()),
          version: z.number().int().optional(),
        }),
        { ids },
        ifMatch(version),
      ),
    // --- (i) settings, keys, webhooks, import/export, data management.
    me: () => request("GET", "/api/v1/me", MeInfo),
    getSettings: () => request("GET", "/api/v1/settings", UserSettings),
    patchSettings: (patch: Record<string, unknown>) =>
      request("PATCH", "/api/v1/settings", UserSettings, patch),
    replaceSettings: (settings: UserSettingsInput) =>
      request("PUT", "/api/v1/settings", UserSettings, settings),
    listKeys: () =>
      request("GET", "/api/v1/keys?limit=200", z.object({ items: z.array(ApiKeyInfo) })),
    createKey: (body: { name: string; scopes: ApiScope[] }) =>
      request("POST", "/api/v1/keys", ApiKeyInfo.extend({ key: z.string() }), body),
    revokeKey: (id: string) =>
      request("DELETE", `/api/v1/keys/${encodeURIComponent(id)}`, ApiKeyInfo),
    listWebhooks: () =>
      request("GET", "/api/v1/webhooks", z.object({ items: z.array(WebhookInfo) })),
    createWebhook: (body: { url: string; events: string[]; description?: string }) =>
      request("POST", "/api/v1/webhooks", WebhookInfo.extend({ secret: z.string() }), body),
    updateWebhook: (
      id: string,
      body: { url?: string; events?: string[]; active?: boolean; description?: string | null },
    ) => request("PATCH", `/api/v1/webhooks/${encodeURIComponent(id)}`, WebhookInfo, body),
    deleteWebhook: (id: string) =>
      request("DELETE", `/api/v1/webhooks/${encodeURIComponent(id)}`, z.unknown()),
    pingWebhook: (id: string) =>
      request("POST", `/api/v1/webhooks/${encodeURIComponent(id)}/ping`, z.unknown(), {}),
    listWebhookDeliveries: (id: string) =>
      request(
        "GET",
        `/api/v1/webhooks/${encodeURIComponent(id)}/deliveries`,
        z.object({ items: z.array(WebhookDelivery) }),
      ),
    /** Whole-workspace import (Glideworth backup or ProjectionLab export). `dryRun` writes nothing. */
    importDocument: (body: {
      format: "glideworth" | "projectionlab" | "auto";
      data: unknown;
      mode?: "create" | "replace" | "merge";
      dryRun?: boolean;
      householdId?: string;
    }) => request("POST", "/api/v1/import", ImportResponse, body),
    exportHousehold: (householdId: string) =>
      request("GET", `/api/v1/households/${encodeURIComponent(householdId)}/export`, z.unknown()),
    deleteHousehold: (householdId: string) =>
      request("DELETE", `/api/v1/households/${encodeURIComponent(householdId)}`, z.unknown()),
    // --- FX rates (household level; plans override through assumptions.fxRates).
    listFxRates: (householdId: string) =>
      request(
        "GET",
        `/api/v1/households/${encodeURIComponent(householdId)}/fx-rates`,
        z.object({ baseCurrency: z.string(), items: z.array(FxRate) }),
      ),
    upsertFxRate: (householdId: string, rate: FxRateInput) =>
      request(
        "POST",
        `/api/v1/households/${encodeURIComponent(householdId)}/fx-rates`,
        z.unknown(),
        rate,
      ),
    replaceFxRates: (householdId: string, items: FxRateInput[]) =>
      request(
        "PUT",
        `/api/v1/households/${encodeURIComponent(householdId)}/fx-rates`,
        z.unknown(),
        {
          items,
        },
      ),
    deleteFxRate: (householdId: string, from: string, to: string) =>
      request(
        "DELETE",
        `/api/v1/households/${encodeURIComponent(householdId)}/fx-rates/${encodeURIComponent(`${from}-${to}`)}`,
        z.unknown(),
      ),
    // --- Check-ins, plan health, notifications.
    getSchedule: () => request("GET", "/api/v1/schedule", Schedule),
    patchSchedule: (patch: Record<string, unknown>) =>
      request("PATCH", "/api/v1/schedule", Schedule, patch),
    runCheckin: (planId: string) =>
      request(
        "POST",
        `/api/v1/plans/${encodeURIComponent(planId)}/checkins`,
        z.object({
          health: PlanHealth,
          previous: PlanHealth.nullable(),
          changes: z.array(CheckInChange),
          notifications: z.array(Notification),
        }),
        {},
      ),
    planHealth: (planId: string, limit = 100) =>
      request(
        "GET",
        `/api/v1/plans/${encodeURIComponent(planId)}/health?limit=${limit}`,
        z.object({ items: z.array(PlanHealth) }),
      ),
    changesSinceCheckin: (planId: string) =>
      request(
        "GET",
        `/api/v1/plans/${encodeURIComponent(planId)}/changes-since-checkin`,
        ChangesSinceCheckin,
      ),
    /** Why the headline results moved since a check-in, by cause (read-only; runs Monte Carlo on the server). */
    resultChange: (planId: string, q: { from?: string; to?: string } = {}) => {
      const qs = new URLSearchParams(
        Object.entries(q).filter((e): e is [string, string] => e[1] !== undefined),
      ).toString();
      return request(
        "GET",
        `/api/v1/plans/${encodeURIComponent(planId)}/result-change${qs ? `?${qs}` : ""}`,
        ResultChangeReport,
      );
    },
    listNotifications: (opts: { unread?: boolean; limit?: number } = {}) =>
      request(
        "GET",
        `/api/v1/notifications?limit=${opts.limit ?? 30}${opts.unread ? "&unread=true" : ""}`,
        z.object({ items: z.array(Notification), unread: z.number().int() }),
      ),
    markNotificationsRead: (body: { ids: string[] } | { all: true }) =>
      request("POST", "/api/v1/notifications/read", z.unknown(), body),
    // --- Share links.
    createShareLink: (
      planId: string,
      body: {
        label?: string;
        privacy: "full" | "percent" | "hidden";
        basis: "real" | "nominal";
        expiresInDays: number;
        includeSuccessRate: boolean;
      },
    ) =>
      request(
        "POST",
        `/api/v1/plans/${encodeURIComponent(planId)}/share-links`,
        z.object({ link: ShareLink, token: z.string(), path: z.string(), apiPath: z.string() }),
        body,
      ),
    listShareLinks: (planId?: string) =>
      request(
        "GET",
        `/api/v1/share-links${planId ? `?planId=${encodeURIComponent(planId)}` : ""}`,
        z.object({ items: z.array(ShareLink) }),
      ),
    revokeShareLink: (id: string) =>
      request("DELETE", `/api/v1/share-links/${encodeURIComponent(id)}`, ShareLink),
    refreshShareLink: (id: string) =>
      request("POST", `/api/v1/share-links/${encodeURIComponent(id)}/refresh`, ShareLink, {}),
    /** Public: no sign-in, the token is the only credential. */
    getShared: (token: string) =>
      request("GET", `/api/v1/shared/${encodeURIComponent(token)}`, SharedPlan),
    // --- People & access.
    listUsers: () => request("GET", "/api/v1/users", z.object({ items: z.array(UserInfo) })),
    inviteUser: (body: { name: string; role: "editor" | "viewer"; login?: string }) =>
      request("POST", "/api/v1/users", z.object({ user: UserInfo, invite: OneTimeToken }), body),
    reinviteUser: (id: string) =>
      request(
        "POST",
        `/api/v1/users/${encodeURIComponent(id)}/invite`,
        z.object({ user: UserInfo, invite: OneTimeToken }),
        {},
      ),
    updateUser: (
      id: string,
      body: { name?: string; role?: "editor" | "viewer"; disabled?: boolean },
    ) => request("PATCH", `/api/v1/users/${encodeURIComponent(id)}`, UserInfo, body),
    deleteUser: (id: string) =>
      request("DELETE", `/api/v1/users/${encodeURIComponent(id)}`, z.unknown()),
    resetUserPassphrase: (id: string) =>
      request(
        "POST",
        `/api/v1/users/${encodeURIComponent(id)}/reset-passphrase`,
        z.object({ user: UserInfo, reset: OneTimeToken }),
        {},
      ),
    auditLog: (
      q: { userId?: string; resourceType?: string; limit?: number; before?: number } = {},
    ) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") qs.set(k, String(v));
      return request(
        "GET",
        `/api/v1/audit-log?${qs}`,
        z.object({ items: z.array(AuditEntry), nextBefore: z.number().nullable().optional() }),
      );
    },
    listMyKeys: () => request("GET", "/api/v1/me/keys", z.object({ items: z.array(ApiKeyInfo) })),
    createMyKey: (body: { name: string; scopes: ApiScope[] }) =>
      request("POST", "/api/v1/me/keys", ApiKeyInfo.extend({ key: z.string() }), body),
    revokeMyKey: (id: string) =>
      request("DELETE", `/api/v1/me/keys/${encodeURIComponent(id)}`, z.unknown()),
    listOAuthGrants: () =>
      request("GET", "/api/v1/me/oauth-grants", z.object({ items: z.array(OAuthGrant) })),
    revokeOAuthGrant: (id: string) =>
      request("DELETE", `/api/v1/me/oauth-grants/${encodeURIComponent(id)}`, z.unknown()),
    listOAuthClients: () =>
      request("GET", "/api/v1/oauth/clients", z.object({ items: z.array(OAuthClient) })),
    deleteOAuthClient: (id: string) =>
      request("DELETE", `/api/v1/oauth/clients/${encodeURIComponent(id)}`, z.unknown()),
    /** Add one item to a plan collection (`expenses`, `income`, `milestones`, `flows`...). */
    addPlanItem: (planId: string, collection: string, item: unknown) =>
      request(
        "POST",
        `/api/v1/plans/${encodeURIComponent(planId)}/${encodeURIComponent(collection)}`,
        z.unknown(),
        item,
      ),
  };
}

// --- (i) admin shapes (mirror apps/api/src/routes/admin.ts).
export type ApiScope = "read" | "simulate" | "write";
export const ApiKeyInfo = z.object({
  id: z.string(),
  userId: z.string().nullable().optional(),
  userName: z.string().nullable().optional(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.enum(["read", "simulate", "write"])),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ApiKeyInfo = z.infer<typeof ApiKeyInfo>;
export const WebhookInfo = z.object({
  id: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  events: z.array(z.string()),
  active: z.boolean(),
  createdAt: z.string(),
});
export type WebhookInfo = z.infer<typeof WebhookInfo>;
export const WebhookDelivery = z.object({
  id: z.string(),
  webhookId: z.string(),
  event: z.string(),
  status: z.enum(["pending", "succeeded", "failed"]),
  attempts: z.number().int(),
  lastStatusCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
});
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;
/** Who made a plan version (`kind` and the person behind it). */
export const PlanActor = z
  .object({
    kind: z.string(),
    id: z.string().nullable().optional(),
    label: z.string().nullable().optional(),
    userId: z.string().nullable().optional(),
    userName: z.string().nullable().optional(),
  })
  .passthrough();
export type PlanActor = z.infer<typeof PlanActor>;

export type Role = "owner" | "editor" | "viewer";
export const MeInfo = z
  .object({
    keyId: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    scopes: z.array(z.string()),
    via: z.string().optional(),
    userId: z.string().nullable().optional(),
    userName: z.string().nullable().optional(),
    role: z.enum(["owner", "editor", "viewer"]).nullable().optional(),
  })
  .passthrough();
export type MeInfo = z.infer<typeof MeInfo>;

export const UserInfo = z.object({
  id: z.string(),
  login: z.string(),
  name: z.string(),
  role: z.enum(["owner", "editor", "viewer"]),
  status: z.enum(["active", "invited", "disabled"]),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
  disabledAt: z.string().nullable().optional(),
});
export type UserInfo = z.infer<typeof UserInfo>;
export const OneTimeToken = z.object({
  token: z.string(),
  kind: z.enum(["invite", "reset"]).optional(),
  expiresAt: z.string(),
});
export const AuditEntry = z.object({
  id: z.number(),
  at: z.string(),
  userId: z.string().nullable(),
  userName: z.string().nullable(),
  via: z.string(),
  credentialId: z.string().nullable(),
  action: z.string(),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  status: z.number().nullable(),
  detail: z.unknown(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
export const OAuthGrant = z.object({
  id: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  refreshExpiresAt: z.string(),
});
export type OAuthGrant = z.infer<typeof OAuthGrant>;
export const OAuthClient = z.object({
  id: z.string(),
  name: z.string(),
  redirectUris: z.array(z.string()),
  scope: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  activeTokens: z.number(),
});
export type OAuthClient = z.infer<typeof OAuthClient>;

export const ShareLink = z.object({
  id: z.string(),
  planId: z.string(),
  label: z.string().nullable(),
  privacy: z.enum(["full", "percent", "hidden"]),
  basis: z.enum(["real", "nominal"]),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  status: z.enum(["active", "expired", "revoked"]),
  snapshotAt: z.string(),
  viewCount: z.number(),
  lastViewedAt: z.string().nullable(),
  createdBy: z.unknown(),
});
export type ShareLink = z.infer<typeof ShareLink>;
const maybeAmount = z.number().nullable();
export const SharedPlan = z.object({
  // 'glideworth-shared-plan': servers not yet upgraded past the rename.
  kind: z.enum(["glideworth-shared-plan", "cairn-shared-plan"]),
  version: z.number(),
  generatedAt: z.string(),
  expiresAt: z.string(),
  label: z.string().nullable(),
  plan: z.object({ name: z.string() }),
  privacy: z.enum(["full", "percent", "hidden"]),
  currency: z.string().nullable().optional(),
  unit: z.string(),
  basis: z.enum(["real", "nominal"]),
  summary: z.object({
    successRate: z.number().nullable(),
    monteCarloTrials: z.number().nullable().optional(),
    fundedThroughout: z.boolean(),
    firstShortfallYear: z.number().nullable(),
    retirementYear: z.number().nullable(),
    financialIndependenceYear: z.number().nullable(),
    startYear: z.number().nullable(),
    endYear: z.number().nullable(),
    endNetWorth: maybeAmount,
  }),
  milestones: z.array(z.object({ name: z.string(), month: z.string().nullable() })),
  years: z.array(
    z.object({
      year: z.number(),
      funded: z.boolean(),
      netWorth: maybeAmount,
      portfolio: maybeAmount,
      income: maybeAmount,
      spending: maybeAmount,
      taxes: maybeAmount,
    }),
  ),
  note: z.string(),
});
export type SharedPlan = z.infer<typeof SharedPlan>;

export const Schedule = z
  .object({
    enabled: z.boolean(),
    cadence: z.enum(["daily", "weekly", "monthly", "quarterly"]),
    intervalHours: z.number().nullable().optional(),
    thresholds: z.object({
      successRateDelta: z.number(),
      milestoneSlipMonths: z.number(),
      netWorthBehindPlan: z.number(),
    }),
    monteCarloTrials: z.number().nullable().optional(),
    lastRunAt: z.string().nullable(),
    nextRunAt: z.string().nullable(),
    running: z.boolean(),
  })
  .passthrough();
export type Schedule = z.infer<typeof Schedule>;
export const PlanHealth = z
  .object({
    id: z.string(),
    planId: z.string(),
    planName: z.string().optional(),
    takenAt: z.string(),
    trigger: z.string(),
    planVersion: z.number(),
    successRate: z.number().nullable(),
    fiYear: z.number().nullable(),
    actualNetWorth: z.number().nullable(),
    plannedNetWorth: z.number().nullable(),
    netWorthVsPlan: z.object({ delta: z.number(), ratio: z.number() }).nullable(),
    endNetWorthReal: z.number().nullable(),
    depletionYear: z.number().nullable(),
    milestones: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        status: z.string(),
        month: z.string().nullable(),
      }),
    ),
    findings: z.array(
      z.object({ key: z.string(), code: z.string(), severity: z.string(), title: z.string() }),
    ),
    currency: z.string(),
  })
  .passthrough();
export type PlanHealth = z.infer<typeof PlanHealth>;
export const CheckInChange = z.object({
  kind: z.string(),
  severity: z.enum(["info", "warning", "critical"]),
  title: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type CheckInChange = z.infer<typeof CheckInChange>;
export const Notification = z.object({
  id: z.string(),
  createdAt: z.string(),
  kind: z.string(),
  severity: z.enum(["info", "warning", "critical"]),
  planId: z.string().nullable(),
  healthId: z.string().nullable(),
  title: z.string(),
  body: z.unknown(),
  read: z.boolean(),
});
export type Notification = z.infer<typeof Notification>;
export const ChangesSinceCheckin = z
  .object({
    since: z.string().nullable(),
    lastCheckIn: PlanHealth.nullable(),
    current: z.unknown().optional(),
    planVersionNow: z.number().nullable().optional(),
    planVersionAtCheckIn: z.number().nullable().optional(),
    // null until the plan has a check-in to compare with (the server cannot say yet).
    householdChanged: z.boolean().nullable().optional(),
    netWorth: z
      .object({
        atCheckIn: z.number().nullable(),
        now: z.number().nullable(),
        change: z.number().nullable(),
      })
      .nullable()
      .optional(),
    edits: z
      .array(
        z.object({
          version: z.number(),
          createdAt: z.string(),
          actor: PlanActor.nullable().optional(),
          message: z.string().nullable(),
        }),
      )
      .optional(),
    changes: z.array(CheckInChange).optional(),
    notifications: z.array(Notification).optional(),
    note: z.string().nullable().optional(),
  })
  .passthrough();
export type ChangesSinceCheckin = z.infer<typeof ChangesSinceCheckin>;

const ResultChangeContext = {
  planId: z.string(),
  planName: z.string(),
  currency: z.string(),
  from: z.object({ checkInId: z.string(), takenAt: z.string() }).nullable(),
  to: z.object({ checkInId: z.string().nullable(), takenAt: z.string() }),
};
export const ResultChangeReport = z.discriminatedUnion("available", [
  ResultChange.extend(ResultChangeContext),
  ResultChangeUnavailable.extend(ResultChangeContext),
]);
export type ResultChangeReport = z.infer<typeof ResultChangeReport>;

export const ImportResponse = z.object({
  format: z.string(),
  dryRun: z.boolean(),
  imported: z.boolean(),
  householdId: z.string(),
  issues: z.array(z.unknown()),
  stats: z.record(z.string(), z.number()),
  report: z.unknown().optional(),
});
export type ImportResponse = z.infer<typeof ImportResponse>;

export type FinancePath = "accounts" | "real-assets" | "debts";
const ifMatch = (v: number | undefined): Record<string, string> =>
  v === undefined ? {} : { "if-match": `"${v}"` };

/** GET/PUT /api/v1/households/{id}: household + current finances + row version (If-Match). */
export const HouseholdRecordBody = z.object({
  household: Household,
  finances: CurrentFinances,
  version: z.number().int(),
});

export type ApiClient = ReturnType<typeof createApiClient>;
export const api = createApiClient();
