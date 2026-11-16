import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FakeStripeGateway } from "../src/gateway/fake.js";
import { loadPricingConfig, type PricingConfig } from "../src/pricing.js";
import { type SyncResult, syncPricing, syncWebhookEndpoint } from "../src/sync.js";
import type { StripeGateway, WebhookEndpointAdmin } from "../src/types.js";

export type AdminGateway = StripeGateway & WebhookEndpointAdmin;

export interface SetupDeps {
  env: Record<string, string | undefined>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  makeGateway: (secretKey: string) => Promise<AdminGateway>;
  loadPricing?: (path: string) => PricingConfig;
  /** Writes the webhook signing secret to a file readable by the owner only (default: node:fs, mode 0600). */
  writeSecretFile?: (path: string, value: string) => void;
}

export const USAGE = `Usage: pnpm --filter @glideworth/billing stripe:setup [options]
       (alias: sync-prices)

Reconciles Stripe with the pricing file: products, prices by lookup key, the Customer Portal
configuration and the webhook endpoint. Safe to run any number of times.

Modes:
  --dry-run            Offline plan. Never contacts Stripe and needs no key; assumes an empty account.
  (default)            Check: read-only calls with the key, prints what would change, writes nothing.
  --apply              Create and update. With a live key (sk_live_/rk_live_) also requires --live.

Options:
  --pricing <file>     Pricing JSON (default: $GLIDEWORTH_PRICING_FILE, else pricing.example.json).
  --public-url <url>   App origin for the portal return URL and <url>/stripe/webhook
                       (default: $GLIDEWORTH_PUBLIC_URL).
  --portal-configuration <id>
                       Existing portal configuration (default: $GLIDEWORTH_STRIPE_PORTAL_CONFIGURATION).
  --archive-removed    Archive prices marked "offered": false (existing subscribers keep billing).
  --no-webhook         Do not create or update the webhook endpoint.
  --webhook-secret-file <path>
                       When the endpoint is created, write its signing secret (whsec_...) to this file
                       (mode 0600, one line, never printed). Stripe returns the secret on creation only.
  --live               Confirm writing to a live-mode account.

Environment: GLIDEWORTH_STRIPE_SECRET_KEY (or STRIPE_SECRET_KEY). The key is never printed.`;

const WRITE_METHODS = new Set([
  "createProduct",
  "createPrice",
  "setPriceActive",
  "upsertPortalConfiguration",
  "createCustomer",
  "createCheckoutSession",
  "createPortalSession",
  "cancelSubscription",
  "createRefund",
  "createWebhookEndpoint",
  "updateWebhookEndpoint",
]);

/** Wraps a gateway so any write throws: the check mode cannot change Stripe even if the sync logic had a bug. */
export function readOnly(g: AdminGateway): AdminGateway {
  return new Proxy(g, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === "string" && WRITE_METHODS.has(prop)) {
        return () => Promise.reject(new Error(`read-only mode: ${prop} refused`));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

interface Args {
  dryRun: boolean;
  apply: boolean;
  live: boolean;
  archiveRemoved: boolean;
  webhook: boolean;
  webhookSecretFile: string | undefined;
  help: boolean;
  pricing: string | undefined;
  publicUrl: string | undefined;
  portalConfiguration: string | undefined;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    apply: false,
    live: false,
    archiveRemoved: false,
    webhook: true,
    webhookSecretFile: undefined,
    help: false,
    pricing: undefined,
    publicUrl: undefined,
    portalConfiguration: undefined,
  };
  const value = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--apply") args.apply = true;
    else if (a === "--live") args.live = true;
    else if (a === "--archive-removed") args.archiveRemoved = true;
    else if (a === "--no-webhook") args.webhook = false;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--webhook-secret-file") args.webhookSecretFile = value(i++, a);
    else if (a === "--pricing") args.pricing = value(i++, a);
    else if (a === "--public-url") args.publicUrl = value(i++, a);
    else if (a === "--portal-configuration") args.portalConfiguration = value(i++, a);
    else throw new Error(`unknown option ${a}`);
  }
  if (args.dryRun && args.apply) throw new Error("--dry-run and --apply cannot be combined");
  return args;
}

const DEFAULT_PRICING = fileURLToPath(new URL("../pricing.example.json", import.meta.url));
const PLACEHOLDER_URL = "https://app.glideworth.example";

function printResult(
  out: (l: string) => void,
  r: SyncResult,
  mode: "dry-run" | "check" | "apply",
): void {
  const verb = mode === "apply" ? "created" : "would create";
  for (const c of r.created) out(`${verb}: ${c}`);
  for (const c of r.archived) out(`${mode === "apply" ? "archived" : "would archive"}: ${c}`);
  for (const c of r.unchanged) out(`unchanged: ${c}`);
  for (const c of r.conflicts) out(`CONFLICT: ${c}`);
}

function writeSecretFile(path: string, value: string): void {
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
}

/** Returns the process exit code: 0 ok, 1 conflicts or Stripe error, 2 usage or configuration error. */
export async function runSetup(argv: string[], deps: SetupDeps): Promise<number> {
  const { stdout: out, stderr: err, env } = deps;
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`error: ${(e as Error).message}`);
    err(USAGE);
    return 2;
  }
  if (args.help) {
    out(USAGE);
    return 0;
  }
  const mode = args.dryRun ? "dry-run" : args.apply ? "apply" : "check";
  const pricingPath = args.pricing ?? env.GLIDEWORTH_PRICING_FILE ?? DEFAULT_PRICING;
  let pricing: PricingConfig;
  try {
    pricing = (deps.loadPricing ?? loadPricingConfig)(pricingPath);
  } catch (e) {
    err(`error: ${(e as Error).message}`);
    return 2;
  }
  const publicUrl = args.publicUrl ?? env.GLIDEWORTH_PUBLIC_URL;
  if (!publicUrl && mode !== "dry-run") {
    err(
      "error: --public-url or GLIDEWORTH_PUBLIC_URL is required (portal return URL and webhook URL)",
    );
    return 2;
  }
  let origin: string;
  try {
    origin = new URL(publicUrl ?? PLACEHOLDER_URL).origin;
  } catch {
    err("error: public URL is not a valid URL");
    return 2;
  }
  const portalConfigurationId =
    args.portalConfiguration ?? env.GLIDEWORTH_STRIPE_PORTAL_CONFIGURATION;

  let gateway: AdminGateway;
  if (mode === "dry-run") {
    out("Dry run: offline plan against an empty Stripe account. Nothing is sent to Stripe.");
    gateway = new FakeStripeGateway();
  } else {
    const key = env.GLIDEWORTH_STRIPE_SECRET_KEY ?? env.STRIPE_SECRET_KEY;
    if (!key) {
      err(
        "error: set GLIDEWORTH_STRIPE_SECRET_KEY (or STRIPE_SECRET_KEY); or use --dry-run for an offline plan",
      );
      return 2;
    }
    const live = /^(sk|rk)_live_/.test(key);
    if (mode === "apply" && live && !args.live) {
      err("error: this is a live-mode key; add --live to confirm writing to the live account");
      return 2;
    }
    out(
      `${mode === "apply" ? "Applying to" : "Checking (read-only)"} Stripe ${live ? "LIVE" : "test"} mode.`,
    );
    gateway = await deps.makeGateway(key);
    if (mode === "check") gateway = readOnly(gateway);
  }

  try {
    out(`Pricing file: ${pricingPath}`);
    const result = await syncPricing(gateway, pricing, {
      apply: mode === "apply",
      archiveRemoved: args.archiveRemoved,
      returnUrl: `${origin}/settings/billing`,
      ...(portalConfigurationId ? { portalConfigurationId } : {}),
    });
    printResult(out, result, mode);
    if (mode === "apply" && result.portalConfigurationId) {
      out(`Portal configuration: ${result.portalConfigurationId}`);
      out(`  set GLIDEWORTH_STRIPE_PORTAL_CONFIGURATION=${result.portalConfigurationId}`);
    }
    if (args.webhook) {
      const url = `${origin}/stripe/webhook`;
      const w = await syncWebhookEndpoint(gateway, { url, apply: mode === "apply" });
      const verb =
        mode === "apply" ? { create: "created", update: "updated", unchanged: "unchanged" } : null;
      out(
        `webhook endpoint ${url}: ${verb ? verb[w.action] : w.action === "unchanged" ? "unchanged" : `would ${w.action}`}${w.id ? ` (${w.id})` : ""}`,
      );
      for (const warning of w.warnings) out(`WARNING: ${warning}`);
      if (mode === "apply" && w.action === "create") {
        if (w.secret && args.webhookSecretFile) {
          (deps.writeSecretFile ?? writeSecretFile)(args.webhookSecretFile, w.secret);
          out(
            `  signing secret written to ${args.webhookSecretFile} (mode 0600); this script never prints it.`,
          );
          out("  Store it as GLIDEWORTH_STRIPE_WEBHOOK_SECRET.");
        } else {
          out(
            "  Reveal the signing secret in the Dashboard (Workbench > Webhooks > the endpoint > Reveal secret)",
          );
          out(
            "  and store it as GLIDEWORTH_STRIPE_WEBHOOK_SECRET (or re-run with --webhook-secret-file for a new endpoint).",
          );
          out("  This script never prints it.");
        }
      }
    }
    if (result.conflicts.length > 0) {
      err(
        `${result.conflicts.length} conflict(s): nothing was changed for them. Prices are immutable in Stripe;`,
      );
      err("bump the lookup key version (_v2) in the pricing file instead of editing amounts.");
      return 1;
    }
    return 0;
  } catch (e) {
    const code =
      (e as { code?: unknown; type?: unknown }).code ?? (e as { type?: unknown }).type ?? "error";
    err(`error: Stripe request failed (${String(code)})`);
    return 1;
  }
}
