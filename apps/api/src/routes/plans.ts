import { Id, OutcomeSummary, PatchOp, Plan, PlanChange, PlanDiff } from "@glideworth/core";
import { z } from "@hono/zod-openapi";
import { parseIfMatch } from "../middleware.js";
import type { Services } from "../services.js";
import { ChangeSetView, ProposeBody } from "../services/changesets.js";
import {
  COLLECTIONS,
  type CollectionDef,
  SINGLETONS,
  type SingletonDef,
} from "../services/plan-parts.js";
import { PageQuery, pageOf, paginate } from "../util.js";
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

const PlanCreate = Plan.omit({
  id: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  lineage: true,
})
  .extend({ id: Id.optional() })
  .meta({ id: "PlanCreate" });
const PlanUpdate = Plan.omit({
  id: true,
  householdId: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  lineage: true,
}).meta({ id: "PlanUpdate" });

const VersionInfo = z
  .object({
    version: z.number().int(),
    createdAt: z.string(),
    actor: z.unknown().describe("Who wrote it: {kind, id, label}."),
    message: z.string().nullable(),
    changeSetId: z.string().nullable(),
  })
  .meta({ id: "PlanVersionInfo" });

const VersionParams = IdParam.extend({
  version: z.coerce
    .number()
    .int()
    .min(1)
    .openapi({ param: { name: "version", in: "path" } }),
});

const patchContent = {
  "application/json-patch+json": { schema: z.array(PatchOp).min(1).max(200) },
  "application/json": { schema: z.array(PatchOp).min(1).max(200) },
};

export function planRoutes({ app, svc }: RouteCtx) {
  const P = "/api/v1/plans";
  const etag = (c: { header: (k: string, v: string) => void }, plan: { version: number }) =>
    c.header("ETag", `"${plan.version}"`);

  app.openapi(
    route("read", {
      method: "get",
      path: P,
      operationId: "listPlans",
      tags: ["Plans"],
      summary: "List plans",
      request: {
        query: PageQuery.extend({
          householdId: Id.optional(),
          status: z.enum(["active", "archived"]).optional(),
          q: z.string().max(120).optional().describe("Case-insensitive name filter."),
        }),
      },
      responses: { 200: json(pageOf(Plan), "Plans") },
    }),
    (c) => {
      const q = c.req.valid("query");
      return c.json(paginate(svc(c).plans.list(q), q), 200);
    },
  );
  app.openapi(
    route("write", {
      method: "post",
      path: P,
      operationId: "createPlan",
      tags: ["Plans"],
      summary: "Create a plan (branches are created with POST /plans/{id}/branches)",
      request: {
        body: { content: { "application/json": { schema: PlanCreate } }, required: true },
      },
      responses: { 201: json(Plan, "Created") },
    }),
    (c) => {
      const plan = svc(c).plans.create(c.req.valid("json"), actorOf(c));
      etag(c, plan);
      return c.json(plan, 201);
    },
  );
  app.openapi(
    route("read", {
      method: "get",
      path: `${P}/{id}`,
      operationId: "getPlan",
      tags: ["Plans"],
      summary: "Get a plan (ETag = version; supports If-None-Match)",
      request: { params: IdParam },
      responses: { 200: json(Plan, "Plan") },
    }),
    (c) => {
      const plan = svc(c).plans.get(c.req.valid("param").id);
      etag(c, plan);
      return c.json(plan, 200);
    },
  );
  app.openapi(
    route("write", {
      method: "put",
      path: `${P}/{id}`,
      operationId: "replacePlan",
      tags: ["Plans"],
      summary: "Replace a plan (If-Match required)",
      request: {
        params: IdParam,
        headers: IfMatch.extend({
          "if-match": z.string().openapi({ description: 'Current plan version, e.g. "3"' }),
        }),
        body: { content: { "application/json": { schema: PlanUpdate } }, required: true },
      },
      responses: { 200: json(Plan, "Updated") },
    }),
    (c) => {
      const { id } = c.req.valid("param");
      const plan = svc(c).plans.replace(
        id,
        { ...c.req.valid("json"), id, householdId: svc(c).plans.get(id).householdId },
        parseIfMatch(c),
        actorOf(c),
      );
      etag(c, plan);
      return c.json(plan, 200);
    },
  );
  app.openapi(
    route("write", {
      method: "patch",
      path: `${P}/{id}`,
      operationId: "patchPlan",
      tags: ["Plans"],
      summary:
        "Edit a plan with RFC 6902 JSON Patch (address array items by id: /income/[id=salary]/amount/value)",
      request: {
        params: IdParam,
        headers: IfMatch,
        body: { content: patchContent, required: true },
      },
      responses: { 200: json(Plan, "Updated") },
    }),
    (c) => {
      const plan = svc(c).plans.patch(
        c.req.valid("param").id,
        c.req.valid("json"),
        parseIfMatch(c),
        actorOf(c),
      );
      etag(c, plan);
      return c.json(plan, 200);
    },
  );
  app.openapi(
    route("write", {
      method: "delete",
      path: `${P}/{id}`,
      operationId: "deletePlan",
      tags: ["Plans"],
      summary:
        "Delete a plan (409 IN_USE when it has branches, unless force=true, which promotes them)",
      request: { params: IdParam, query: z.object({ force: z.coerce.boolean().default(false) }) },
      responses: Deleted,
    }),
    (c) => {
      svc(c).plans.delete(
        c.req.valid("param").id,
        { force: c.req.valid("query").force },
        actorOf(c),
      );
      return c.body(null, 204);
    },
  );

  // ----------------------------------------------------------------------------- lifecycle
  app.openapi(
    route("write", {
      method: "post",
      path: `${P}/{id}/duplicate`,
      operationId: "duplicatePlan",
      tags: ["Plans"],
      summary: "Duplicate a plan into an independent copy",
      request: {
        params: IdParam,
        body: {
          content: {
            "application/json": {
              schema: z.object({ name: z.string().min(1).max(120).optional() }),
            },
          },
          required: false,
        },
      },
      responses: { 201: json(Plan, "The copy") },
    }),
    async (c) => {
      const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { name?: string };
      const plan = svc(c).plans.duplicate(c.req.valid("param").id, { name: body.name }, actorOf(c));
      etag(c, plan);
      return c.json(plan, 201);
    },
  );
  for (const [seg, op, fn] of [
    [
      "archive",
      "archivePlan",
      (s: Services, id: string, v: number | undefined, a: ReturnType<typeof actorOf>) =>
        s.plans.setArchived(id, true, v, a),
    ],
    [
      "unarchive",
      "unarchivePlan",
      (s: Services, id: string, v: number | undefined, a: ReturnType<typeof actorOf>) =>
        s.plans.setArchived(id, false, v, a),
    ],
    [
      "set-main",
      "setMainPlan",
      (s: Services, id: string, v: number | undefined, a: ReturnType<typeof actorOf>) =>
        s.plans.setMain(id, v, a),
    ],
  ] as const) {
    app.openapi(
      route("write", {
        method: "post",
        path: `${P}/{id}/${seg}`,
        operationId: op,
        tags: ["Plans"],
        summary:
          seg === "set-main"
            ? "Make this the main plan (the previous main plan is demoted)"
            : seg === "archive"
              ? "Archive a plan (kept, hidden from active lists)"
              : "Restore an archived plan",
        request: { params: IdParam, headers: IfMatch },
        responses: { 200: json(Plan, "Updated plan") },
      }),
      (c) => {
        const plan = fn(svc(c), c.req.valid("param").id, parseIfMatch(c), actorOf(c));
        etag(c, plan);
        return c.json(plan, 200);
      },
    );
  }

  // ----------------------------------------------------------------------------- versions / undo
  app.openapi(
    route("read", {
      method: "get",
      path: `${P}/{id}/versions`,
      operationId: "listPlanVersions",
      tags: ["Plan history"],
      summary: "Plan history, newest first (one entry per write, with actor and message)",
      request: { params: IdParam, query: PageQuery },
      responses: { 200: json(pageOf(VersionInfo), "Versions") },
    }),
    (c) => {
      const q = c.req.valid("query");
      return c.json(paginate(svc(c).plans.listVersions(c.req.valid("param").id), q), 200);
    },
  );
  app.openapi(
    route("read", {
      method: "get",
      path: `${P}/{id}/versions/{version}`,
      operationId: "getPlanVersion",
      tags: ["Plan history"],
      summary: "The full plan body at an earlier version",
      request: { params: VersionParams },
      responses: { 200: json(Plan, "Plan as of that version") },
    }),
    (c) => {
      const p = c.req.valid("param");
      return c.json(svc(c).plans.versionBody(p.id, p.version), 200);
    },
  );
  app.openapi(
    route("read", {
      method: "get",
      path: `${P}/{id}/versions/{version}/diff`,
      operationId: "diffPlanVersion",
      tags: ["Plan history"],
      summary: "What changed between a version and another version (default: the current plan)",
      request: {
        params: VersionParams,
        query: z.object({
          against: z.string().default("current").describe("'current' or a version number"),
        }),
      },
      responses: { 200: json(PlanDiff, "Diff") },
    }),
    (c) => {
      const p = c.req.valid("param");
      const a = c.req.valid("query").against;
      return c.json(
        svc(c).plans.diffVersions(p.id, p.version, a === "current" ? "current" : Number(a)),
        200,
      );
    },
  );
  app.openapi(
    route("write", {
      method: "post",
      path: `${P}/{id}/versions/{version}/restore`,
      operationId: "restorePlanVersion",
      tags: ["Plan history"],
      summary: "Undo: write an earlier version back as a NEW version (history is never rewritten)",
      request: { params: VersionParams, headers: IfMatch },
      responses: { 200: json(Plan, "Restored plan") },
    }),
    (c) => {
      const p = c.req.valid("param");
      const plan = svc(c).plans.restore(p.id, p.version, parseIfMatch(c), actorOf(c));
      etag(c, plan);
      return c.json(plan, 200);
    },
  );

  // ----------------------------------------------------------------------------- branches
  app.openapi(
    route("write", {
      method: "post",
      path: `${P}/{id}/branches`,
      operationId: "createBranch",
      tags: ["Branches"],
      summary:
        "Branch a plan: a child that stores a patch over its parent and follows (or pins) the parent version",
      request: {
        params: IdParam,
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  name: z.string().min(1).max(120),
                  description: z.string().max(2000).optional(),
                  patch: z
                    .array(PatchOp)
                    .max(200)
                    .optional()
                    .describe("Initial edits (RFC 6902, id-addressed)."),
                  pinParentVersion: z
                    .boolean()
                    .default(false)
                    .describe("Pin to the current parent version instead of following the parent."),
                })
                .meta({ id: "CreateBranch" }),
            },
          },
          required: true,
        },
      },
      responses: { 201: json(Plan, "The branch (a normal plan with `lineage`)") },
    }),
    (c) => {
      const plan = svc(c).plans.createBranch(
        c.req.valid("param").id,
        c.req.valid("json"),
        actorOf(c),
      );
      etag(c, plan);
      return c.json(plan, 201);
    },
  );
  app.openapi(
    route("read", {
      method: "get",
      path: `${P}/{id}/branches`,
      operationId: "listBranches",
      tags: ["Branches"],
      summary: "Branches of a plan",
      request: { params: IdParam },
      responses: { 200: json(z.object({ items: z.array(Plan) }), "Branches") },
    }),
    (c) => {
      const id = c.req.valid("param").id;
      svc(c).plans.get(id);
      return c.json({ items: svc(c).plans.children(id) }, 200);
    },
  );
  app.openapi(
    route("simulate", {
      method: "get",
      path: `${P}/{id}/diff`,
      operationId: "diffBranchAgainstParent",
      tags: ["Branches"],
      summary:
        "Diff a branch against its parent, with before/after outcomes (outcome=true runs two projections)",
      request: { params: IdParam, query: z.object({ outcome: z.coerce.boolean().default(true) }) },
      responses: {
        200: json(
          z.object({
            parentPlanId: Id,
            branchPlanId: Id,
            changes: z.array(PlanChange),
            patch: z.array(PatchOp),
            outcome: z.object({ parent: OutcomeSummary, branch: OutcomeSummary }).optional(),
          }),
          "Diff",
        ),
      },
    }),
    (c) => {
      const { parent, branch, diff } = svc(c).plans.diffAgainstParent(c.req.valid("param").id);
      const outcome = c.req.valid("query").outcome
        ? { parent: svc(c).sim.outcome(parent.id), branch: svc(c).sim.outcome(branch.id) }
        : undefined;
      return c.json(
        {
          parentPlanId: parent.id,
          branchPlanId: branch.id,
          changes: diff.changes,
          patch: diff.patch,
          ...(outcome ? { outcome } : {}),
        },
        200,
      );
    },
  );
  app.openapi(
    route("write", {
      method: "post",
      path: `${P}/{id}/merge`,
      operationId: "mergeBranch",
      tags: ["Branches"],
      summary:
        "Merge a branch: into its parent, or promote it to a standalone (optionally main) plan",
      request: {
        params: IdParam,
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  strategy: z.enum(["into-parent", "promote"]).default("into-parent"),
                  keepBranch: z
                    .boolean()
                    .default(false)
                    .describe("into-parent: keep the branch (rebased) instead of deleting it."),
                  makeMain: z
                    .boolean()
                    .default(false)
                    .describe("promote: also make it the main plan."),
                  expectedParentVersion: z.number().int().optional(),
                  force: z
                    .boolean()
                    .default(false)
                    .describe("Merge even when a pinned branch is behind its parent."),
                })
                .meta({ id: "MergeBranch" }),
            },
          },
          required: false,
        },
      },
      responses: { 200: json(z.object({ plan: Plan, branchDeleted: z.boolean() }), "Result") },
    }),
    async (c) => {
      const raw = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const body = z
        .object({
          strategy: z.enum(["into-parent", "promote"]).default("into-parent"),
          keepBranch: z.boolean().default(false),
          makeMain: z.boolean().default(false),
          expectedParentVersion: z.number().int().optional(),
          force: z.boolean().default(false),
        })
        .parse(raw);
      const out = svc(c).plans.merge(c.req.valid("param").id, body, actorOf(c));
      etag(c, out.plan);
      return c.json({ plan: out.plan, branchDeleted: out.branchDeleted }, 200);
    },
  );

  // ----------------------------------------------------------------------------- change sets (per plan)
  const CS = "/api/v1/change-sets";
  app.openapi(
    route("write", {
      method: "post",
      path: `${P}/{id}/change-sets`,
      operationId: "proposeChangeSet",
      tags: ["Change sets"],
      summary:
        "Propose edits WITHOUT applying: returns the diff and a before/after simulation summary",
      description:
        "The safe way for agents (and UIs) to edit: propose RFC 6902 ops against the current plan version, review `changes` and `preview`, then `apply` or `discard`. " +
        "Applying fails with 409 CHANGESET_CONFLICT if the plan changed in the meantime.",
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ProposeBody } }, required: true },
      },
      responses: { 201: json(ChangeSetView, "Proposed change set") },
    }),
    (c) =>
      c.json(
        svc(c).changeSets.propose(c.req.valid("param").id, c.req.valid("json"), actorOf(c)),
        201,
      ),
  );
  app.openapi(
    route("read", {
      method: "get",
      path: `${P}/{id}/change-sets`,
      operationId: "listChangeSets",
      tags: ["Change sets"],
      summary: "Change sets proposed for a plan (newest first)",
      request: {
        params: IdParam,
        query: PageQuery.extend({
          status: z.enum(["proposed", "applied", "discarded", "conflict"]).optional(),
        }),
      },
      responses: { 200: json(pageOf(ChangeSetView), "Change sets") },
    }),
    (c) => {
      const q = c.req.valid("query");
      return c.json(
        paginate(svc(c).changeSets.list({ planId: c.req.valid("param").id, status: q.status }), q),
        200,
      );
    },
  );
  app.openapi(
    route("read", {
      method: "get",
      path: `${CS}/{id}`,
      operationId: "getChangeSet",
      tags: ["Change sets"],
      summary: "Get a change set",
      request: { params: IdParam },
      responses: { 200: json(ChangeSetView, "Change set") },
    }),
    (c) => c.json(svc(c).changeSets.get(c.req.valid("param").id), 200),
  );
  app.openapi(
    route("write", {
      method: "post",
      path: `${CS}/{id}/apply`,
      operationId: "applyChangeSet",
      tags: ["Change sets"],
      summary:
        "Apply a proposed change set (atomic; writes a plan version attributed to the caller)",
      request: { params: IdParam },
      responses: { 200: json(z.object({ changeSet: ChangeSetView, plan: Plan }), "Applied") },
    }),
    (c) => {
      const out = svc(c).changeSets.apply(c.req.valid("param").id, actorOf(c));
      etag(c, out.plan);
      return c.json(out, 200);
    },
  );
  app.openapi(
    route("write", {
      method: "post",
      path: `${CS}/{id}/discard`,
      operationId: "discardChangeSet",
      tags: ["Change sets"],
      summary: "Discard a proposed change set",
      request: { params: IdParam },
      responses: { 200: json(ChangeSetView, "Discarded") },
    }),
    (c) => c.json(svc(c).changeSets.discard(c.req.valid("param").id), 200),
  );
  app.openapi(
    route("simulate", {
      method: "post",
      path: `${P}/{id}/preview`,
      operationId: "previewEdits",
      tags: ["Change sets"],
      summary: "What-if: diff + before/after outcome for some edits, storing nothing",
      request: {
        params: IdParam,
        body: {
          content: {
            "application/json": { schema: z.object({ ops: z.array(PatchOp).min(1).max(200) }) },
          },
          required: true,
        },
      },
      responses: {
        200: json(
          z.object({
            changes: z.array(PlanChange),
            preview: z.object({ before: OutcomeSummary, after: OutcomeSummary }).optional(),
          }),
          "Preview",
        ),
      },
    }),
    (c) => {
      const out = svc(c).sim.preview(c.req.valid("param").id, c.req.valid("json").ops);
      return c.json({ changes: out.diff.changes, preview: out.preview }, 200);
    },
  );

  // ----------------------------------------------------------------------------- nested collections
  for (const def of COLLECTIONS) collectionRoutes(def);
  for (const def of SINGLETONS) singletonRoutes(def);

  function collectionRoutes(def: CollectionDef) {
    const slug =
      def.key === "plannedAccounts"
        ? "planned-accounts"
        : def.key === "plannedRealAssets"
          ? "planned-real-assets"
          : def.key;
    const base = `${P}/{id}/${slug}`;
    const name = def.key[0]!.toUpperCase() + def.key.slice(1);
    const Create = withOptionalId(def.schema, `${name}Create`);
    const Item = IdParam.extend({ itemId: pathId("itemId") });
    app.openapi(
      route("read", {
        method: "get",
        path: base,
        operationId: `list${name}`,
        tags: [def.tag],
        summary: `List the plan's ${def.label}s`,
        request: { params: IdParam },
        responses: { 200: json(z.object({ items: z.array(def.schema) }), "Items") },
      }),
      (c) => {
        const id = c.req.valid("param").id;
        const items = svc(c).parts.list(id, def.key);
        etag(c, svc(c).plans.get(id));
        return c.json({ items } as never, 200);
      },
    );
    app.openapi(
      route("write", {
        method: "post",
        path: base,
        operationId: `add${name}`,
        tags: [def.tag],
        summary: `Add a ${def.label}`,
        request: {
          params: IdParam,
          headers: IfMatch,
          query: z.object({
            index: z.coerce
              .number()
              .int()
              .min(0)
              .optional()
              .describe("Insert position (default: append)."),
          }),
          body: { content: { "application/json": { schema: Create } }, required: true },
        },
        responses: { 201: json(def.schema, "Created") },
      }),
      (c) => {
        const out = svc(c).parts.create(
          c.req.valid("param").id,
          def.key,
          c.req.valid("json") as Record<string, unknown>,
          {
            index: c.req.valid("query").index,
            expectedVersion: parseIfMatch(c),
            actor: actorOf(c),
          },
        );
        etag(c, out.plan);
        return c.json(out.item as never, 201);
      },
    );
    app.openapi(
      route("read", {
        method: "get",
        path: `${base}/{itemId}`,
        operationId: `get${name}Item`,
        tags: [def.tag],
        summary: `Get a ${def.label}`,
        request: { params: Item },
        responses: { 200: json(def.schema, "Item") },
      }),
      (c) => {
        const p = c.req.valid("param");
        etag(c, svc(c).plans.get(p.id));
        return c.json(svc(c).parts.get(p.id, def.key, p.itemId) as never, 200);
      },
    );
    for (const mode of ["replace", "merge"] as const) {
      app.openapi(
        route("write", {
          method: mode === "replace" ? "put" : "patch",
          path: `${base}/{itemId}`,
          operationId: `${mode === "replace" ? "replace" : "patch"}${name}Item`,
          tags: [def.tag],
          summary:
            mode === "replace"
              ? `Replace a ${def.label}`
              : `Partially update a ${def.label} (JSON Merge Patch)`,
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
          responses: { 200: json(def.schema, "Updated") },
        }),
        (c) => {
          const p = c.req.valid("param");
          const out = svc(c).parts.update(
            p.id,
            def.key,
            p.itemId,
            c.req.valid("json") as Record<string, unknown>,
            mode,
            {
              expectedVersion: parseIfMatch(c),
              actor: actorOf(c),
            },
          );
          etag(c, out.plan);
          return c.json(out.item as never, 200);
        },
      );
    }
    app.openapi(
      route("write", {
        method: "delete",
        path: `${base}/{itemId}`,
        operationId: `remove${name}Item`,
        tags: [def.tag],
        summary: `Remove a ${def.label}`,
        request: { params: Item, headers: IfMatch },
        responses: Deleted,
      }),
      (c) => {
        const p = c.req.valid("param");
        svc(c).parts.delete(p.id, def.key, p.itemId, {
          expectedVersion: parseIfMatch(c),
          actor: actorOf(c),
        });
        return c.body(null, 204);
      },
    );
    app.openapi(
      route("write", {
        method: "put",
        path: `${P}/{id}/reorder/${slug}`,
        operationId: `reorder${name}`,
        tags: [def.tag],
        summary: `Reorder the ${def.label}s${def.key === "flows" ? " (the order is the funding priority)" : ""}`,
        request: {
          params: IdParam,
          headers: IfMatch,
          body: {
            content: { "application/json": { schema: z.object({ ids: z.array(Id) }) } },
            required: true,
          },
        },
        responses: { 200: json(z.object({ items: z.array(def.schema) }), "Reordered") },
      }),
      (c) => {
        const plan = svc(c).parts.reorder(
          c.req.valid("param").id,
          def.key,
          c.req.valid("json").ids,
          {
            expectedVersion: parseIfMatch(c),
            actor: actorOf(c),
          },
        );
        etag(c, plan);
        return c.json(
          { items: (plan as unknown as Record<string, unknown[]>)[def.key] } as never,
          200,
        );
      },
    );
  }

  function singletonRoutes(def: SingletonDef) {
    const seg =
      def.key === "tax"
        ? "tax-settings"
        : def.key === "monteCarlo"
          ? "monte-carlo-settings"
          : def.key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    const base = `${P}/{id}/${seg}`;
    const name = def.key[0]!.toUpperCase() + def.key.slice(1);
    app.openapi(
      route("read", {
        method: "get",
        path: base,
        operationId: `get${name}`,
        tags: [def.tag],
        summary: `Get the plan's ${def.label}`,
        request: { params: IdParam },
        responses: { 200: json(def.schema, def.label) },
      }),
      (c) => {
        const id = c.req.valid("param").id;
        etag(c, svc(c).plans.get(id));
        return c.json(svc(c).parts.getSingleton(id, def.key) as never, 200);
      },
    );
    for (const mode of ["replace", "merge"] as const) {
      app.openapi(
        route("write", {
          method: mode === "replace" ? "put" : "patch",
          path: base,
          operationId: `${mode === "replace" ? "set" : "patch"}${name}`,
          tags: [def.tag],
          summary:
            mode === "replace"
              ? `Replace the plan's ${def.label}`
              : `Partially update the plan's ${def.label} (JSON Merge Patch)`,
          request: {
            params: IdParam,
            headers: IfMatch,
            body: {
              content: {
                "application/json": { schema: mode === "replace" ? def.schema : MergePatchBody },
              },
              required: true,
            },
          },
          responses: { 200: json(def.schema, "Updated") },
        }),
        (c) => {
          const out = svc(c).parts.putSingleton(
            c.req.valid("param").id,
            def.key,
            c.req.valid("json"),
            mode,
            {
              expectedVersion: parseIfMatch(c),
              actor: actorOf(c),
            },
          );
          etag(c, out.plan);
          return c.json(out.value as never, 200);
        },
      );
    }
    app.openapi(
      route("write", {
        method: "delete",
        path: base,
        operationId: `${def.optional ? "remove" : "reset"}${name}`,
        tags: [def.tag],
        summary: def.optional
          ? `Remove the plan's ${def.label}`
          : `Reset the plan's ${def.label} to defaults`,
        request: { params: IdParam, headers: IfMatch },
        responses: Deleted,
      }),
      (c) => {
        svc(c).parts.deleteSingleton(c.req.valid("param").id, def.key, {
          expectedVersion: parseIfMatch(c),
          actor: actorOf(c),
        });
        return c.body(null, 204);
      },
    );
  }
}
