/**
 * Sparse partials for plan-level behaviour patches.
 *
 * Zod's `.partial()` keeps each field's `.default()` inside the optional wrapper, so parsing a
 * one-key override such as `{ liquid: 'never' }` fills every other field with its default and the
 * patch silently resets the entity's own settings. `sparsePartial` strips the top-level defaults:
 * an absent key stays absent, so `{ ...entity.behaviour, ...patch }` only changes what the patch
 * names. Nested objects keep their own defaults (a patch replaces a whole top-level key).
 *
 * The inferred output type is the same as `schema.partial()`.
 */
import { z } from "zod";

export function sparsePartial<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
): ReturnType<z.ZodObject<T>["partial"]> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape) as [string, z.ZodType][]) {
    const inner = field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : field;
    shape[key] = inner instanceof z.ZodOptional ? inner : inner.optional();
  }
  return z.object(shape) as unknown as ReturnType<z.ZodObject<T>["partial"]>;
}
