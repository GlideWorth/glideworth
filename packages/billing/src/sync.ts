import { WEBHOOK_ENABLED_EVENTS } from "./events.js";
import { STRIPE_API_VERSION } from "./gateway/stripe.js";
import type { PriceConfig, PricingConfig } from "./pricing.js";
import type { StripeGateway, StripePriceView, WebhookEndpointAdmin } from "./types.js";

export interface SyncResult {
  /** Entries that were created (or, in a dry run, would be): `product:<id>`, `price:<lookupKey>`, … */
  created: string[];
  unchanged: string[];
  /** Differences that need a human: a price whose amount, currency, interval or tax behaviour differs. */
  conflicts: string[];
  archived: string[];
  portalConfigurationId: string | null;
}

function priceDifferences(want: PriceConfig, productId: string, have: StripePriceView): string[] {
  const diffs: string[] = [];
  if (have.productId !== productId) diffs.push(`product ${have.productId} != ${productId}`);
  if (have.currency !== want.currency) diffs.push(`currency ${have.currency} != ${want.currency}`);
  if (have.unitAmount !== want.unitAmount)
    diffs.push(`unitAmount ${have.unitAmount} != ${want.unitAmount}`);
  if (have.interval !== want.interval) diffs.push(`interval ${have.interval} != ${want.interval}`);
  if (have.taxBehavior !== want.taxBehavior)
    diffs.push(`taxBehavior ${have.taxBehavior} != ${want.taxBehavior}`);
  const currencies = new Set([
    ...Object.keys(want.currencyOptions),
    ...Object.keys(have.currencyOptions),
  ]);
  for (const cur of [...currencies].sort()) {
    const w = want.currencyOptions[cur];
    const h = have.currencyOptions[cur];
    if (!w) diffs.push(`currencyOptions.${cur} only in Stripe`);
    else if (!h) diffs.push(`currencyOptions.${cur} missing in Stripe`);
    else {
      if (w.unitAmount !== h.unitAmount)
        diffs.push(`currencyOptions.${cur}.unitAmount ${h.unitAmount} != ${w.unitAmount}`);
      if (w.taxBehavior !== h.taxBehavior) {
        diffs.push(`currencyOptions.${cur}.taxBehavior ${h.taxBehavior} != ${w.taxBehavior}`);
      }
    }
  }
  return diffs;
}

/**
 * Reconciles Stripe with the pricing file (design 4.1). Dry run unless `apply`. Idempotent: products by fixed id,
 * prices by lookup key (created with idempotency key `price:<lookupKey>`), the portal configuration by id (or by
 * the metadata marker the adapter sets). A price that exists with different terms is a conflict, never an update:
 * Stripe prices are immutable, so the fix is a new `_vN` lookup key.
 *
 * `archiveRemoved` archives prices that the file marks `offered: false` (Stripe keeps billing existing subscribers on
 * an archived price; it only stops new purchases). An offered price that is archived in Stripe is reactivated.
 */
export async function syncPricing(
  g: StripeGateway,
  cfg: PricingConfig,
  o: { apply: boolean; archiveRemoved: boolean; returnUrl: string; portalConfigurationId?: string },
): Promise<SyncResult> {
  const result: SyncResult = {
    created: [],
    unchanged: [],
    conflicts: [],
    archived: [],
    portalConfigurationId: null,
  };

  for (const product of cfg.products) {
    const existing = await g.retrieveProduct(product.id);
    if (!existing) {
      if (o.apply) {
        await g.createProduct(
          {
            id: product.id,
            name: product.name,
            ...(product.description ? { description: product.description } : {}),
          },
          `product:${product.id}`,
        );
      }
      result.created.push(`product:${product.id}`);
    } else if (!existing.active) {
      result.conflicts.push(
        `product:${product.id}: archived in Stripe; reactivate it in the Dashboard`,
      );
    } else {
      result.unchanged.push(`product:${product.id}`);
    }
  }

  const keys = cfg.products.flatMap((p) => p.prices.map((x) => x.lookupKey));
  const found = await g.listPricesByLookupKeys(keys);
  const byKey = new Map<string, StripePriceView>();
  for (const p of found) {
    // Stripe keeps a lookup key on one price at a time; two would mean someone transferred keys by hand.
    if (byKey.has(p.lookupKey))
      result.conflicts.push(`price:${p.lookupKey}: more than one Stripe price has this key`);
    byKey.set(p.lookupKey, p);
  }

  const priceIds = new Map<string, string>();
  for (const product of cfg.products) {
    for (const price of product.prices) {
      const label = `price:${price.lookupKey}`;
      const have = byKey.get(price.lookupKey);
      if (!have) {
        if (o.apply) {
          const created = await g.createPrice({ productId: product.id, price }, label);
          priceIds.set(price.lookupKey, created.id);
        }
        result.created.push(label);
        continue;
      }
      priceIds.set(price.lookupKey, have.id);
      const diffs = priceDifferences(price, product.id, have);
      if (diffs.length > 0) {
        result.conflicts.push(
          `${label}: ${diffs.join("; ")} (prices are immutable: add a new _vN lookup key)`,
        );
        continue;
      }
      if (price.offered && !have.active) {
        if (o.apply) await g.setPriceActive(have.id, true);
        result.created.push(`${label} (reactivated)`);
      } else if (!price.offered && have.active && o.archiveRemoved) {
        if (o.apply) await g.setPriceActive(have.id, false);
        result.archived.push(label);
      } else {
        result.unchanged.push(label);
      }
    }
  }

  // Portal: switching is allowed only among offered prices.
  const portalPrices = cfg.products
    .map((product) => ({
      productId: product.id,
      priceIds: product.prices
        .filter((p) => p.offered)
        .map((p) => priceIds.get(p.lookupKey))
        .filter((id): id is string => id !== undefined),
    }))
    .filter((p) => p.priceIds.length > 0);

  if (!o.apply) {
    result.portalConfigurationId = o.portalConfigurationId ?? null;
    result[o.portalConfigurationId ? "unchanged" : "created"].push(
      o.portalConfigurationId
        ? `portal:${o.portalConfigurationId} (would be reconciled)`
        : "portal:configuration (create, or update the one marked as managed)",
    );
    return result;
  }
  if (result.conflicts.length > 0) {
    // Do not point the portal at a price set that needs a human decision.
    return result;
  }
  const portal = await g.upsertPortalConfiguration({
    prices: portalPrices,
    returnUrl: o.returnUrl,
    ...(o.portalConfigurationId ? { existingId: o.portalConfigurationId } : {}),
  });
  result.portalConfigurationId = portal.id;
  result.unchanged.push(`portal:${portal.id}`);
  return result;
}

export const WEBHOOK_DESCRIPTION = "Glideworth Cloud billing (managed by stripe:setup)";

/**
 * Creates or reconciles the webhook endpoint for `<publicUrl>/stripe/webhook` with the handled event types. The
 * signing secret is never returned: reveal it in the Dashboard. An endpoint with a different API version is
 * reported, not changed (Stripe does not allow changing it; create a new endpoint and roll over).
 */
export async function syncWebhookEndpoint(
  g: WebhookEndpointAdmin,
  o: { url: string; apply: boolean },
): Promise<{
  action: "create" | "update" | "unchanged";
  id: string | null;
  /** The signing secret, present only right after a creation. Never log it. */
  secret?: string;
  warnings: string[];
}> {
  const wanted = [...WEBHOOK_ENABLED_EVENTS].sort();
  const endpoints = await g.listWebhookEndpoints();
  const existing = endpoints.find((e) => e.url === o.url);
  const warnings: string[] = [];
  if (!existing) {
    const created = o.apply
      ? await g.createWebhookEndpoint(
          {
            url: o.url,
            enabledEvents: wanted,
            description: WEBHOOK_DESCRIPTION,
            apiVersion: STRIPE_API_VERSION,
          },
          `webhook-endpoint:${o.url}`,
        )
      : null;
    return {
      action: "create",
      id: created?.id ?? null,
      ...(created?.secret ? { secret: created.secret } : {}),
      warnings,
    };
  }
  if (existing.apiVersion !== null && existing.apiVersion !== STRIPE_API_VERSION) {
    warnings.push(
      `endpoint ${existing.id} uses API version ${existing.apiVersion}, expected ${STRIPE_API_VERSION}`,
    );
  }
  if (existing.status !== "enabled") warnings.push(`endpoint ${existing.id} is ${existing.status}`);
  const have = [...existing.enabledEvents].sort();
  const same = have.length === wanted.length && have.every((e, i) => e === wanted[i]);
  if (same && existing.description === WEBHOOK_DESCRIPTION)
    return { action: "unchanged", id: existing.id, warnings };
  if (o.apply)
    await g.updateWebhookEndpoint(existing.id, {
      enabledEvents: wanted,
      description: WEBHOOK_DESCRIPTION,
    });
  return { action: "update", id: existing.id, warnings };
}
