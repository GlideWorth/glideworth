import { readFileSync } from "node:fs";
import { z } from "zod";
import { BillingError } from "./errors.js";

const count = z.number().int().nonnegative();

/** Plan limits (design section 6.1). Unknown keys are rejected so a typo in the pricing file fails loudly. */
export const PlanLimitsSchema = z.strictObject({
  editors: count,
  viewers: count,
  apiRequestsPerMinute: count,
  apiRequestsPerDay: count,
  concurrentJobs: count,
  queuedJobs: count,
  jobsPerDay: count,
  workerSecondsPerDay: count,
  maxJobSeconds: count,
  maxMonteCarloTrials: count,
  webhooks: count,
  webhookDeliveriesPerDay: count,
  shareLinks: count,
  shareReadsPerDay: count,
  apiKeys: count,
  storageMb: count,
});
export type PlanLimits = z.infer<typeof PlanLimitsSchema>;

export type TaxBehavior = "inclusive" | "exclusive";

export interface PriceConfig {
  /** `/^[a-z0-9_]+_v\d+$/`; Stripe prices are immutable, so a changed price gets a new version suffix. */
  lookupKey: string;
  interval: "month" | "year";
  /** ISO 4217, lowercase. */
  currency: string;
  /** Minor units. */
  unitAmount: number;
  taxBehavior: TaxBehavior;
  currencyOptions: Record<string, { unitAmount: number; taxBehavior: TaxBehavior }>;
  /** Offered to new subscribers (checkout and portal switching). Existing subscribers stay on non-offered prices. */
  offered: boolean;
}

export interface ProductConfig {
  id: string;
  name: string;
  description?: string;
  limits: PlanLimits;
  prices: PriceConfig[];
}

export interface PricingConfig {
  version: 1;
  trialDays: number;
  pastDueGraceDays: number;
  trialEndingNoticeDays: number;
  trialProductId: string;
  products: ProductConfig[];
  checkout: { allowPromotionCodes: boolean; collectTaxIds: boolean };
}

export const LOOKUP_KEY_PATTERN = /^[a-z0-9_]+_v\d+$/;
const CURRENCY_PATTERN = /^[a-z]{3}$/;
/** Stripe allows any unique string; we keep product ids to a conservative alphabet. */
const PRODUCT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const taxBehavior = z.enum(["inclusive", "exclusive"]);
const amount = z.number().int().positive().max(99_999_999);
const currency = z
  .string()
  .regex(CURRENCY_PATTERN, 'currency must be a lowercase ISO 4217 code such as "usd"');

export const PriceConfigSchema: z.ZodType<PriceConfig> = z
  .strictObject({
    lookupKey: z
      .string()
      .max(200)
      .regex(
        LOOKUP_KEY_PATTERN,
        'lookupKey must match /^[a-z0-9_]+_v\\d+$/, for example "cloud_monthly_v1"',
      ),
    interval: z.enum(["month", "year"]),
    currency,
    unitAmount: amount,
    taxBehavior,
    currencyOptions: z.record(currency, z.strictObject({ unitAmount: amount, taxBehavior })),
    offered: z.boolean(),
  })
  .superRefine((p, ctx) => {
    if (Object.hasOwn(p.currencyOptions, p.currency)) {
      ctx.addIssue({
        code: "custom",
        path: ["currencyOptions", p.currency],
        message: "currencyOptions must not repeat the primary currency",
      });
    }
  });

const ProductConfigSchema: z.ZodType<ProductConfig> = z.strictObject({
  id: z.string().regex(PRODUCT_ID_PATTERN, "product id must be 1-64 characters of [A-Za-z0-9_-]"),
  name: z.string().min(1).max(250),
  description: z.string().min(1).max(1000).optional(),
  limits: PlanLimitsSchema,
  prices: z.array(PriceConfigSchema).min(1),
});

export const PricingConfigSchema: z.ZodType<PricingConfig> = z
  .strictObject({
    version: z.literal(1),
    trialDays: z.number().int().min(0).max(365),
    pastDueGraceDays: z.number().int().min(0).max(90),
    trialEndingNoticeDays: z.number().int().min(0).max(365),
    trialProductId: z.string().min(1),
    products: z.array(ProductConfigSchema).min(1),
    checkout: z.strictObject({ allowPromotionCodes: z.boolean(), collectTaxIds: z.boolean() }),
  })
  .superRefine((cfg, ctx) => {
    const productIds = new Set<string>();
    cfg.products.forEach((product, i) => {
      if (productIds.has(product.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["products", i, "id"],
          message: `duplicate product id "${product.id}"`,
        });
      }
      productIds.add(product.id);
    });
    if (!productIds.has(cfg.trialProductId)) {
      ctx.addIssue({
        code: "custom",
        path: ["trialProductId"],
        message: `trialProductId "${cfg.trialProductId}" is not one of the configured products`,
      });
    }
    const keys = new Set<string>();
    cfg.products.forEach((product, i) => {
      product.prices.forEach((price, j) => {
        if (keys.has(price.lookupKey)) {
          ctx.addIssue({
            code: "custom",
            path: ["products", i, "prices", j, "lookupKey"],
            message: `duplicate lookupKey "${price.lookupKey}"`,
          });
        }
        keys.add(price.lookupKey);
      });
    });
    if (cfg.trialDays > 0 && cfg.trialEndingNoticeDays >= cfg.trialDays) {
      ctx.addIssue({
        code: "custom",
        path: ["trialEndingNoticeDays"],
        message: "trialEndingNoticeDays must be shorter than trialDays",
      });
    }
  });

/** Parses an already-loaded value; throws `BillingError('CONFIG_INVALID')` listing every issue with its path. */
export function parsePricingConfig(value: unknown): PricingConfig {
  const result = PricingConfigSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join(".") || "(root)",
      message: issue.message,
    }));
    throw new BillingError(
      "CONFIG_INVALID",
      `Invalid pricing config: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      { issues },
    );
  }
  return result.data;
}

export function loadPricingConfig(path: string): PricingConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new BillingError("CONFIG_INVALID", "Pricing file cannot be read", {
      code: (err as { code?: string }).code ?? "UNKNOWN",
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BillingError("CONFIG_INVALID", "Pricing file is not valid JSON");
  }
  return parsePricingConfig(json);
}

export function findPrice(
  cfg: PricingConfig,
  lookupKey: string,
): { product: ProductConfig; price: PriceConfig } | null {
  for (const product of cfg.products) {
    for (const price of product.prices) {
      if (price.lookupKey === lookupKey) return { product, price };
    }
  }
  return null;
}

/** Limits of the given product, or of the trial product when the id is unknown (for example a removed product). */
export function limitsFor(cfg: PricingConfig, productId: string | null | undefined): PlanLimits {
  const product =
    cfg.products.find((p) => p.id === productId) ??
    cfg.products.find((p) => p.id === cfg.trialProductId);
  if (!product) throw new BillingError("CONFIG_INVALID", "trialProductId does not name a product");
  return product.limits;
}
