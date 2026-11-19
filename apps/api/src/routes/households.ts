import {
  Account,
  CurrentFinances,
  Debt,
  Dependent,
  GlideworthDocument,
  Household,
  Person,
  ProgressSnapshot,
  RealAsset,
} from "@glideworth/core";
import { z } from "@hono/zod-openapi";
import { ApiError } from "../errors.js";
import { parseIfMatch } from "../middleware.js";
import {
  BalanceUpdate,
  FINANCE_LABEL,
  type FinanceKind,
  SnapshotCreate,
} from "../services/households.js";
import {
  BankFileImportBody,
  CsvAnalyzeBody,
  CsvImportBody,
  ImportBody,
} from "../services/imports.js";
import { type Page, PageQuery, pageOf, paginate } from "../util.js";
import {
  actorOf,
  Deleted,
  IdParam,
  IfMatch,
  json,
  MergePatchBody,
  pathId,
  type RouteCtx,
  route,
  withOptionalId,
} from "./helpers.js";

const HouseholdBundle = z
  .object({ household: Household, finances: CurrentFinances })
  .meta({ id: "HouseholdBundle" });
const HouseholdRecord = HouseholdBundle.extend({ version: z.number().int() }).meta({
  id: "HouseholdRecord",
});
/** The whole editable "current finances" document: people + every account, real asset and debt. */
const CurrentFinancesDocument = z
  .object({
    household: Household.optional().describe(
      "People, dependents, location... Omit to leave the household body unchanged.",
    ),
    finances: CurrentFinances,
  })
  .meta({ id: "CurrentFinancesDocument" });
const CurrentFinancesSaved = HouseholdRecord.extend({
  snapshot: ProgressSnapshot.nullable().describe(
    "Today's automatic progress snapshot, when this save created or updated it.",
  ),
}).meta({ id: "CurrentFinancesSaved" });
const ReorderBody = z
  .object({
    ids: z
      .array(z.string().min(1).max(64))
      .max(500)
      .describe("Ids in the desired display order; unlisted ids follow, in their current order."),
  })
  .meta({ id: "ReorderRequest" });
const COLLECTIONS = ["accounts", "real-assets", "debts", "plans"] as const;
const HouseholdCreate = z
  .object({
    household: Household,
    finances: CurrentFinances.optional().describe(
      "Omit to start with no balances, dated this month.",
    ),
  })
  .meta({ id: "HouseholdCreate" });

const sub = (name: string) => z.object({ id: pathId("id"), [name]: pathId(name) });
const SnapshotParams = IdParam.extend({ snapId: pathId("snapId") });

const FINANCE: {
  kind: FinanceKind;
  path: string;
  schema: z.ZodType;
  metaId: string;
  tag: string;
}[] = [
  { kind: "accounts", path: "accounts", schema: Account, metaId: "AccountCreate", tag: "Accounts" },
  {
    kind: "realAssets",
    path: "real-assets",
    schema: RealAsset,
    metaId: "RealAssetCreate",
    tag: "Real assets",
  },
  { kind: "debts", path: "debts", schema: Debt, metaId: "DebtCreate", tag: "Debts" },
];

export function householdRoutes({ app, svc }: RouteCtx) {
  const H = "/api/v1/households";

  app.openapi(
    route("read", {
      method: "get",
      path: H,
      operationId: "listHouseholds",
      tags: ["Households"],
      summary: "List households",
      request: { query: PageQuery },
      responses: { 200: json(pageOf(Household), "Households") },
    }),
    (c) => c.json(paginate(svc(c).households.list(), c.req.valid("query")), 200),
  );
  app.openapi(
    route("write", {
      method: "post",
      path: H,
      operationId: "createHousehold",
      tags: ["Households"],
      summary: "Create a household with its current finances",
      request: {
        body: { content: { "application/json": { schema: HouseholdCreate } }, required: true },
      },
      responses: { 201: json(HouseholdRecord, "Created") },
    }),
    (c) => {
      const rec = svc(c).households.create(c.req.valid("json"));
      c.header("ETag", `"${rec.version}"`);
      return c.json(rec, 201);
    },
  );
  app.openapi(
    route("read", {
      method: "get",
      path: `${H}/{id}`,
      operationId: "getHousehold",
      tags: ["Households"],
      summary: "Get a household and its current finances (ETag = version; supports If-None-Match)",
      request: { params: IdParam },
      responses: { 200: json(HouseholdRecord, "Household") },
    }),
    (c) => {
      const rec = svc(c).households.get(c.req.valid("param").id);
      c.header("ETag", `"${rec.version}"`);
      return c.json(rec, 200);
    },
  );
  app.openapi(
    route("write", {
      method: "put",
      path: `${H}/{id}`,
      operationId: "replaceHousehold",
      tags: ["Households"],
      summary:
        "Replace the household body (people, dependents, location, currency...), or the whole current-finances document",
      description:
        "Send a Household to replace just the body. Send `{ household?, finances }` (see `PUT /households/{id}/current-finances`) to save people, accounts, assets and debts atomically in one request.",
      request: {
        params: IdParam,
        headers: IfMatch,
        body: {
          content: {
            "application/json": { schema: z.union([CurrentFinancesDocument, Household]) },
          },
          required: true,
        },
      },
      responses: { 200: json(CurrentFinancesSaved, "Updated") },
    }),
    (c) => {
      const id = c.req.valid("param").id;
      const body = c.req.valid("json") as unknown as Record<string, unknown>;
      if ("finances" in body && !("people" in body)) {
        const out = svc(c).households.replaceCurrent(
          id,
          body as { household?: unknown; finances: unknown },
          parseIfMatch(c),
          actorOf(c),
        );
        c.header("ETag", `"${out.record.version}"`);
        return c.json({ ...out.record, snapshot: out.snapshot }, 200);
      }
      const rec = svc(c).households.update(id, body, "replace", parseIfMatch(c));
      c.header("ETag", `"${rec.version}"`);
      return c.json({ ...rec, snapshot: null }, 200);
    },
  );
  app.openapi(
    route("write", {
      method: "put",
      path: `${H}/{id}/current-finances`,
      operationId: "replaceCurrentFinances",
      tags: ["Households"],
      summary:
        "Save the whole current-finances document atomically: people, accounts, real assets and debts",
      description:
        'One validated, all-or-nothing write that replaces the household body (when given) and `finances`. Use `If-Match: "<version>"` (the household ETag) so an edit made elsewhere is a 409 VERSION_CONFLICT instead of being overwritten. ' +
        "If balances changed and `settings.autoProgressSnapshots` is on, today's automatic progress snapshot is created or updated (at most one per day). The response carries the new version (also the ETag).",
      request: {
        params: IdParam,
        headers: IfMatch,
        body: {
          content: { "application/json": { schema: CurrentFinancesDocument } },
          required: true,
        },
      },
      responses: { 200: json(CurrentFinancesSaved, "Saved") },
    }),
    (c) => {
      const out = svc(c).households.replaceCurrent(
        c.req.valid("param").id,
        c.req.valid("json") as { household?: unknown; finances: unknown },
        parseIfMatch(c),
        actorOf(c),
      );
      c.header("ETag", `"${out.record.version}"`);
      return c.json({ ...out.record, snapshot: out.snapshot }, 200);
    },
  );
  app.openapi(
    route("write", {
      method: "put",
      path: `${H}/{id}/reorder/{collection}`,
      operationId: "reorderHouseholdCollection",
      tags: ["Households"],
      summary: "Persist the display order of accounts, real assets, debts or plans",
      description:
        "Ids listed come first in the given order; the rest keep their relative order after them. An unknown id is a 404 and changes nothing. For accounts/real-assets/debts the order is the array order of the stored document (so list endpoints, export and the web app all agree) and `If-Match` is the household version; for plans it is stored per household and `If-Match` is ignored.",
      request: {
        params: IdParam.extend({
          collection: z.enum(COLLECTIONS).openapi({ param: { name: "collection", in: "path" } }),
        }),
        headers: IfMatch,
        body: { content: { "application/json": { schema: ReorderBody } }, required: true },
      },
      responses: {
        200: json(
          z.object({
            collection: z.enum(COLLECTIONS),
            ids: z.array(z.string()),
            version: z.number().int().optional(),
          }),
          "The resulting order of every id",
        ),
      },
    }),
    (c) => {
      const { id, collection } = c.req.valid("param");
      const { ids } = c.req.valid("json");
      if (collection === "plans") {
        const ordered = svc(c).plans.reorder(id, ids);
        return c.json({ collection, ids: ordered.map((p) => p.id) }, 200);
      }
      const kind: FinanceKind = collection === "real-assets" ? "realAssets" : collection;
      const rec = svc(c).households.reorderFinance(id, kind, ids, parseIfMatch(c), actorOf(c));
      c.header("ETag", `"${rec.version}"`);
      return c.json(
        {
          collection,
          ids: (rec.finances[kind] as { id: string }[]).map((x) => x.id),
          version: rec.version,
        },
        200,
      );
    },
  );
  app.openapi(
    route("write", {
      method: "patch",
      path: `${H}/{id}`,
      operationId: "patchHousehold",
      tags: ["Households"],
      summary: "Merge-patch household fields",
      request: {
        params: IdParam,
        headers: IfMatch,
        body: {
          content: {
            "application/merge-patch+json": { schema: MergePatchBody },
            "application/json": { schema: MergePatchBody },
          },
          required: true,
        },
      },
      responses: { 200: json(HouseholdRecord, "Updated") },
    }),
    (c) => {
      const rec = svc(c).households.update(
        c.req.valid("param").id,
        c.req.valid("json"),
        "merge",
        parseIfMatch(c),
      );
      c.header("ETag", `"${rec.version}"`);
      return c.json(rec, 200);
    },
  );
  app.openapi(
    route("write", {
      method: "delete",
      path: `${H}/{id}`,
      operationId: "deleteHousehold",
      tags: ["Households"],
      summary: "Delete a household and everything in it (plans, history, snapshots)",
      request: { params: IdParam },
      responses: Deleted,
    }),
    (c) => {
      svc(c).households.delete(c.req.valid("param").id);
      return c.body(null, 204);
    },
  );
  app.openapi(
    route("read", {
      method: "get",
      path: `${H}/{id}/document`,
      operationId: "getHouseholdDocument",
      tags: ["Data"],
      summary:
        "Whole workspace (household, finances, plans, progress, settings) as a GlideworthDocument",
      request: { params: IdParam },
      responses: { 200: json(GlideworthDocument, "Document") },
    }),
    (c) => c.json(svc(c).households.getDocument(c.req.valid("param").id), 200),
  );
  app.openapi(
    route("read", {
      method: "get",
      path: `${H}/{id}/export`,
      operationId: "exportHousehold",
      tags: ["Data"],
      summary:
        "Full-data export (backup). Same shape as /document, served as a download; re-import with POST /import",
      request: { params: IdParam },
      responses: { 200: json(GlideworthDocument, "Document file") },
    }),
    (c) => {
      const id = c.req.valid("param").id;
      c.header("Content-Disposition", `attachment; filename="glideworth-${id}.json"`);
      return c.json(svc(c).households.getDocument(id), 200);
    },
  );

  // ----------------------------------------------------------------------------- people & dependents
  const peopleRoutes = <T extends z.ZodType>(
    seg: "people" | "dependents",
    schema: T,
    name: "person" | "dependent",
    tag: string,
  ) => {
    const Create = withOptionalId(schema, name === "person" ? "PersonCreate" : "DependentCreate");
    const ItemParams = sub(`${name}Id`);
    const idOf = (c: { req: { valid: (k: "param") => unknown } }) =>
      c.req.valid("param") as Record<string, string>;
    app.openapi(
      route("read", {
        method: "get",
        path: `${H}/{id}/${seg}`,
        operationId: `list${seg === "people" ? "People" : "Dependents"}`,
        tags: [tag],
        summary: `List ${seg}`,
        request: { params: IdParam },
        responses: { 200: json(z.object({ items: z.array(schema) }), "Items") },
      }),
      (c) => {
        const h = svc(c).households.get(c.req.valid("param").id).household;
        return c.json({ items: seg === "people" ? h.people : h.dependents } as never, 200);
      },
    );
    app.openapi(
      route("write", {
        method: "post",
        path: `${H}/{id}/${seg}`,
        operationId: `add${name === "person" ? "Person" : "Dependent"}`,
        tags: [tag],
        summary: `Add a ${name}${name === "person" ? " (adding a second person switches the household to couple mode)" : ""}`,
        request: {
          params: IdParam,
          headers: IfMatch,
          body: { content: { "application/json": { schema: Create } }, required: true },
        },
        responses: { 201: json(schema, "Created") },
      }),
      (c) => {
        const id = c.req.valid("param").id;
        const body = c.req.valid("json") as Record<string, unknown>;
        const withId = {
          ...body,
          id:
            body.id ??
            `${name === "person" ? "p" : "dep"}_${Math.random().toString(36).slice(2, 10)}`,
        };
        const out =
          seg === "people"
            ? svc(c).households.addPerson(id, withId, parseIfMatch(c))
            : svc(c).households.addDependent(id, withId, parseIfMatch(c));
        c.header("ETag", `"${out.record.version}"`);
        return c.json(
          (seg === "people"
            ? (out as { person: unknown }).person
            : (out as { dependent: unknown }).dependent) as never,
          201,
        );
      },
    );
    app.openapi(
      route("read", {
        method: "get",
        path: `${H}/{id}/${seg}/{${name}Id}`,
        operationId: `get${name === "person" ? "Person" : "Dependent"}`,
        tags: [tag],
        summary: `Get a ${name}`,
        request: { params: ItemParams },
        responses: { 200: json(schema, "Item") },
      }),
      (c) => {
        const p = idOf(c);
        const h = svc(c).households.get(p.id!).household;
        const list = (seg === "people" ? h.people : h.dependents) as { id: string }[];
        const item = list.find((x) => x.id === p[`${name}Id`]);
        if (!item) throw new ApiError(404, "NOT_FOUND", `${name} '${p[`${name}Id`]}' not found`);
        return c.json(item as never, 200);
      },
    );
    for (const mode of ["replace", "merge"] as const) {
      app.openapi(
        route("write", {
          method: mode === "replace" ? "put" : "patch",
          path: `${H}/{id}/${seg}/{${name}Id}`,
          operationId: `${mode === "replace" ? "replace" : "patch"}${name === "person" ? "Person" : "Dependent"}`,
          tags: [tag],
          summary: mode === "replace" ? `Replace a ${name}` : `Merge-patch a ${name}`,
          request: {
            params: ItemParams,
            headers: IfMatch,
            body: {
              content: {
                "application/json": { schema: mode === "replace" ? Create : MergePatchBody },
              },
              required: true,
            },
          },
          responses: { 200: json(schema, "Updated") },
        }),
        (c) => {
          const p = idOf(c);
          const body = c.req.valid("json") as Record<string, unknown>;
          const itemId = p[`${name}Id`]!;
          const patch = mode === "replace" ? { ...body, id: itemId } : body;
          const out =
            seg === "people"
              ? svc(c).households.updatePerson(p.id!, itemId, patch, parseIfMatch(c))
              : svc(c).households.updateDependent(p.id!, itemId, patch, parseIfMatch(c));
          c.header("ETag", `"${out.record.version}"`);
          return c.json(
            (seg === "people"
              ? (out as { person: unknown }).person
              : (out as { dependent: unknown }).dependent) as never,
            200,
          );
        },
      );
    }
    app.openapi(
      route("write", {
        method: "delete",
        path: `${H}/{id}/${seg}/{${name}Id}`,
        operationId: `remove${name === "person" ? "Person" : "Dependent"}`,
        tags: [tag],
        summary: `Remove a ${name}`,
        request: { params: ItemParams, headers: IfMatch },
        responses: Deleted,
      }),
      (c) => {
        const p = idOf(c);
        if (seg === "people")
          svc(c).households.removePerson(p.id!, p[`${name}Id`]!, parseIfMatch(c));
        else svc(c).households.removeDependent(p.id!, p[`${name}Id`]!, parseIfMatch(c));
        return c.body(null, 204);
      },
    );
  };
  peopleRoutes("people", Person, "person", "People");
  peopleRoutes("dependents", Dependent, "dependent", "People");

  // ----------------------------------------------------------------------------- accounts / real assets / debts
  const FinanceQuery = PageQuery.extend({
    includeArchived: z.coerce.boolean().default(false),
  });
  for (const f of FINANCE) {
    const label = FINANCE_LABEL[f.kind];
    const Create = withOptionalId(f.schema, f.metaId);
    const Item = IdParam.extend({ itemId: pathId("itemId") });
    const opBase =
      f.kind === "accounts" ? "Account" : f.kind === "realAssets" ? "RealAsset" : "Debt";
    const plural =
      f.kind === "accounts" ? "Accounts" : f.kind === "realAssets" ? "RealAssets" : "Debts";
    app.openapi(
      route("read", {
        method: "get",
        path: `${H}/{id}/${f.path}`,
        operationId: `list${plural}`,
        tags: [f.tag],
        summary: `List ${label}s`,
        request: { params: IdParam, query: FinanceQuery },
        responses: { 200: json(pageOf(f.schema), "Items") },
      }),
      (c) => {
        const q = c.req.valid("query");
        return c.json(
          paginate(
            svc(c).households.listFinance(c.req.valid("param").id, f.kind, q.includeArchived),
            q,
          ) as Page<never>,
          200,
        );
      },
    );
    app.openapi(
      route("write", {
        method: "post",
        path: `${H}/{id}/${f.path}`,
        operationId: `create${opBase}`,
        tags: [f.tag],
        summary: `Create a ${label}`,
        request: {
          params: IdParam,
          headers: IfMatch,
          body: { content: { "application/json": { schema: Create } }, required: true },
        },
        responses: { 201: json(f.schema, "Created") },
      }),
      (c) => {
        const out = svc(c).households.createFinance(
          c.req.valid("param").id,
          f.kind,
          c.req.valid("json") as Record<string, unknown>,
          parseIfMatch(c),
          actorOf(c),
        );
        c.header("ETag", `"${out.record.version}"`);
        return c.json(out.item as never, 201);
      },
    );
    app.openapi(
      route("read", {
        method: "get",
        path: `${H}/{id}/${f.path}/{itemId}`,
        operationId: `get${opBase}`,
        tags: [f.tag],
        summary: `Get a ${label}`,
        request: { params: Item },
        responses: { 200: json(f.schema, "Item") },
      }),
      (c) => {
        const p = c.req.valid("param");
        return c.json(svc(c).households.getFinance(p.id, f.kind, p.itemId) as never, 200);
      },
    );
    for (const mode of ["replace", "merge"] as const) {
      app.openapi(
        route("write", {
          method: mode === "replace" ? "put" : "patch",
          path: `${H}/{id}/${f.path}/{itemId}`,
          operationId: `${mode === "replace" ? "replace" : "patch"}${opBase}`,
          tags: [f.tag],
          summary:
            mode === "replace"
              ? `Replace a ${label}`
              : `Merge-patch a ${label} (e.g. just its balance)`,
          request: {
            params: Item,
            headers: IfMatch,
            body: {
              content: {
                "application/json": { schema: mode === "replace" ? Create : MergePatchBody },
              },
              required: true,
            },
          },
          responses: { 200: json(f.schema, "Updated") },
        }),
        (c) => {
          const p = c.req.valid("param");
          const out = svc(c).households.updateFinance(
            p.id,
            f.kind,
            p.itemId,
            c.req.valid("json") as Record<string, unknown>,
            mode,
            parseIfMatch(c),
            actorOf(c),
          );
          c.header("ETag", `"${out.record.version}"`);
          return c.json(out.item as never, 200);
        },
      );
    }
    app.openapi(
      route("write", {
        method: "delete",
        path: `${H}/{id}/${f.path}/{itemId}`,
        operationId: `delete${opBase}`,
        tags: [f.tag],
        summary: `Delete a ${label} (409 IN_USE when plans reference it, unless force=true; prefer archived=true)`,
        request: {
          params: Item,
          headers: IfMatch,
          query: z.object({ force: z.coerce.boolean().default(false) }),
        },
        responses: Deleted,
      }),
      (c) => {
        const p = c.req.valid("param");
        svc(c).households.deleteFinance(
          p.id,
          f.kind,
          p.itemId,
          { force: c.req.valid("query").force, expected: parseIfMatch(c) },
          actorOf(c),
        );
        return c.body(null, 204);
      },
    );
  }

  app.openapi(
    route("write", {
      method: "post",
      path: `${H}/{id}/balances`,
      operationId: "updateBalances",
      tags: ["Accounts"],
      summary: "Bulk balance update (integration use case: a budgeting tool pushes balances)",
      description:
        "Updates balances of many accounts / real-asset values / debts atomically: if any id is unknown nothing changes (404 with details.unknownIds). " +
        "Optionally moves `asOf` and records a progress snapshot (default: per settings.autoProgressSnapshots).",
      request: {
        params: IdParam,
        headers: IfMatch,
        body: { content: { "application/json": { schema: BalanceUpdate } }, required: true },
      },
      responses: {
        200: json(
          z.object({
            updated: z.object({
              accounts: z.number().int(),
              realAssets: z.number().int(),
              debts: z.number().int(),
            }),
            version: z.number().int().describe("New household version."),
            snapshot: ProgressSnapshot.nullable().describe(
              "The recorded progress snapshot, if any.",
            ),
          }),
          "Updated",
        ),
      },
    }),
    (c) => {
      const out = svc(c).households.updateBalances(
        c.req.valid("param").id,
        c.req.valid("json"),
        parseIfMatch(c),
        actorOf(c),
      );
      c.header("ETag", `"${out.version}"`);
      return c.json(out, 200);
    },
  );

  // ----------------------------------------------------------------------------- progress snapshots
  const SnapQuery = PageQuery.extend({
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Earliest date (YYYY-MM-DD)."),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Latest date (YYYY-MM-DD)."),
  });
  app.openapi(
    route("read", {
      method: "get",
      path: `${H}/{id}/snapshots`,
      operationId: "listSnapshots",
      tags: ["Progress"],
      summary: "List progress snapshots (newest first)",
      request: { params: IdParam, query: SnapQuery },
      responses: { 200: json(pageOf(ProgressSnapshot), "Snapshots") },
    }),
    (c) => {
      const q = c.req.valid("query");
      return c.json(paginate(svc(c).households.listSnapshots(c.req.valid("param").id, q), q), 200);
    },
  );
  app.openapi(
    route("write", {
      method: "post",
      path: `${H}/{id}/snapshots`,
      operationId: "createSnapshot",
      tags: ["Progress"],
      summary: "Record a progress snapshot with explicit values",
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: SnapshotCreate } }, required: true },
      },
      responses: { 201: json(ProgressSnapshot, "Created") },
    }),
    (c) =>
      c.json(svc(c).households.createSnapshot(c.req.valid("param").id, c.req.valid("json")), 201),
  );
  app.openapi(
    route("write", {
      method: "post",
      path: `${H}/{id}/snapshots/record`,
      operationId: "recordSnapshot",
      tags: ["Progress"],
      summary: "Record a snapshot of the household's CURRENT finances (net worth today)",
      request: {
        params: IdParam,
        body: {
          content: {
            "application/json": {
              schema: z.object({
                date: z
                  .string()
                  .regex(/^\d{4}-\d{2}-\d{2}$/)
                  .optional(),
                note: z.string().max(500).optional(),
              }),
            },
          },
          required: false,
        },
      },
      responses: { 201: json(ProgressSnapshot, "Created") },
    }),
    async (c) => {
      const body = ((await c.req.json().catch(() => ({}))) ?? {}) as {
        date?: string;
        note?: string;
      };
      return c.json(
        svc(c).households.recordCurrent(c.req.valid("param").id, {
          source: "api",
          ...(body.date ? { date: body.date } : {}),
          ...(body.note ? { note: body.note } : {}),
        }),
        201,
      );
    },
  );
  app.openapi(
    route("write", {
      method: "post",
      path: `${H}/{id}/snapshots/bulk`,
      operationId: "bulkImportSnapshots",
      tags: ["Progress"],
      summary: "Bulk import (backfill) progress snapshots, atomically",
      request: {
        params: IdParam,
        body: {
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(SnapshotCreate).min(1).max(5000),
                onConflict: z
                  .enum(["skip", "replace", "error"])
                  .default("skip")
                  .describe("What to do when an item id already exists."),
              }),
            },
          },
          required: true,
        },
      },
      responses: {
        200: json(
          z.object({
            created: z.number().int(),
            replaced: z.number().int(),
            skipped: z.number().int(),
          }),
          "Result",
        ),
      },
    }),
    (c) => {
      const b = c.req.valid("json");
      return c.json(
        svc(c).households.bulkImportSnapshots(c.req.valid("param").id, b.items, b.onConflict),
        200,
      );
    },
  );
  app.openapi(
    route("read", {
      method: "get",
      path: `${H}/{id}/snapshots/{snapId}`,
      operationId: "getSnapshot",
      tags: ["Progress"],
      summary: "Get a snapshot",
      request: { params: SnapshotParams },
      responses: { 200: json(ProgressSnapshot, "Snapshot") },
    }),
    (c) => {
      const p = c.req.valid("param");
      return c.json(svc(c).households.getSnapshot(p.id, p.snapId), 200);
    },
  );
  for (const mode of ["replace", "merge"] as const) {
    app.openapi(
      route("write", {
        method: mode === "replace" ? "put" : "patch",
        path: `${H}/{id}/snapshots/{snapId}`,
        operationId: mode === "replace" ? "replaceSnapshot" : "patchSnapshot",
        tags: ["Progress"],
        summary:
          mode === "replace"
            ? "Replace a snapshot"
            : "Merge-patch a snapshot (edit values, date or note)",
        request: {
          params: SnapshotParams,
          body: {
            content: {
              "application/json": { schema: mode === "replace" ? SnapshotCreate : MergePatchBody },
            },
            required: true,
          },
        },
        responses: { 200: json(ProgressSnapshot, "Updated") },
      }),
      (c) => {
        const p = c.req.valid("param");
        return c.json(
          svc(c).households.updateSnapshot(
            p.id,
            p.snapId,
            c.req.valid("json") as Record<string, unknown>,
            mode,
          ),
          200,
        );
      },
    );
  }
  app.openapi(
    route("write", {
      method: "delete",
      path: `${H}/{id}/snapshots/{snapId}`,
      operationId: "deleteSnapshot",
      tags: ["Progress"],
      summary: "Delete a snapshot",
      request: { params: SnapshotParams },
      responses: Deleted,
    }),
    (c) => {
      const p = c.req.valid("param");
      svc(c).households.deleteSnapshot(p.id, p.snapId);
      return c.body(null, 204);
    },
  );

  // ----------------------------------------------------------------------------- import
  /** Security review finding 4: imports are parsed in a worker thread; its limits, stated on every import route. */
  const IMPORT_THREAD =
    "The file is parsed in a separate import thread, so other requests are not held up. " +
    "An import that runs longer than the time limit (15 s by default) is stopped: `422 IMPORT_TIMEOUT`, nothing written; one that needs more memory than allowed is `422 IMPORT_OUT_OF_MEMORY`. " +
    "When every import thread is busy and the import queue is full the answer is `503 IMPORT_BUSY` with `Retry-After`; a workspace may run 2 imports at once, a third is `429 RATE_LIMITED` with `Retry-After`. " +
    "An apply whose household changed while the file was being parsed is `409 VERSION_CONFLICT` and writes nothing.";
  app.openapi(
    route("write", {
      method: "post",
      path: "/api/v1/import",
      operationId: "importDocument",
      tags: ["Data"],
      summary:
        "Import a Glideworth export or a ProjectionLab export (dryRun=true returns issues and stats only)",
      description: IMPORT_THREAD,
      request: {
        body: { content: { "application/json": { schema: ImportBody } }, required: true },
      },
      responses: {
        200: json(
          z.object({
            format: z.string(),
            dryRun: z.boolean(),
            imported: z.boolean(),
            householdId: z.string(),
            issues: z.array(z.unknown()),
            stats: z.record(z.string(), z.number()),
            report: z
              .unknown()
              .optional()
              .describe(
                "ProjectionLab imports: per-entity counts, issue tallies and the key-path coverage table.",
              ),
          }),
          "Import report",
        ),
      },
    }),
    async (c) =>
      c.json((await svc(c).imports.import(c.req.valid("json"), actorOf(c))) as never, 200),
  );
  app.openapi(
    route("write", {
      method: "post",
      path: `${H}/{id}/import/csv/analyze`,
      operationId: "analyzeCsv",
      tags: ["Data"],
      summary:
        "Detect the delimiter, bank preset, columns, date and number formats of a CSV (writes nothing)",
      description: IMPORT_THREAD,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: CsvAnalyzeBody } }, required: true },
      },
      responses: { 200: json(z.record(z.string(), z.unknown()), "Analysis with a sample of rows") },
    }),
    async (c) => c.json((await svc(c).imports.analyzeCsv(c.req.valid("json"))) as never, 200),
  );
  app.openapi(
    route("write", {
      method: "post",
      path: `${H}/{id}/import/csv`,
      operationId: "importCsv",
      tags: ["Data"],
      summary:
        "CSV import: account balances, progress/net-worth history or transactions. dryRun (the default) previews only",
      description:
        "Preview first (`dryRun: true`, the default): you get the CSV analysis, any issues and a reconciliation (matched / created / unmatched accounts with before/after balances). " +
        "Repeat with `dryRun: false` to apply atomically (finances, snapshots and, for transactions, the plan in one transaction); blocking errors are a 422 IMPORT_FAILED and nothing is written. " +
        IMPORT_THREAD,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: CsvImportBody } }, required: true },
      },
      responses: { 200: json(z.record(z.string(), z.unknown()), "Preview or result") },
    }),
    async (c) =>
      c.json(
        (await svc(c).imports.importCsv(
          c.req.valid("param").id,
          c.req.valid("json"),
          actorOf(c),
        )) as never,
        200,
      ),
  );
  app.openapi(
    route("write", {
      method: "post",
      path: `${H}/{id}/import/bank-file`,
      operationId: "importBankFile",
      tags: ["Data"],
      summary: "OFX / QFX / QIF import: balances and spending. dryRun (the default) previews only",
      description:
        "Bank and card statements: balances are reconciled against current finances like the CSV balance import (match by name or `balances.accountMap`, optionally create missing accounts; foreign-currency accounts keep their currency), and transactions are summarised into annual expense events on `planId` (transfers, income and card payments are excluded; an expense keeps the statement currency). Account numbers are masked to their last four digits. A currency with no rate to the household currency is a warning (`bank.fx-missing`); pass `fxRates` to store one with the import. Without a rate the plan cannot be simulated and the balance is left out of net worth. " +
        "Preview first (`dryRun: true`, the default); repeat with `dryRun: false` to apply atomically. Blocking errors are `422 IMPORT_FAILED` and nothing is written. " +
        "`text` is limited to 2 MB (2,000,000 characters); a larger file is refused with `400 VALIDATION` before it is parsed. " +
        "One apply may create at most 1,000 new accounts and debts with `balances.createMissing`; more is a `400 VALIDATION` naming the limit, and nothing is written. A dry run still reports how many it would create (`reconciliation.created`). " +
        IMPORT_THREAD,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: BankFileImportBody } }, required: true },
      },
      responses: { 200: json(z.record(z.string(), z.unknown()), "Preview or result") },
    }),
    async (c) =>
      c.json(
        (await svc(c).imports.importBankFile(
          c.req.valid("param").id,
          c.req.valid("json"),
          actorOf(c),
        )) as never,
        200,
      ),
  );
}
