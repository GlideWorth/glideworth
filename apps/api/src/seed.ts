import { createSampleDocument } from "@glideworth/core/samples";
import type { Db } from "./db/client.js";
import { households } from "./db/schema.js";
import { Services } from "./services.js";

/** Seed the synthetic sample into an empty database. Returns true when seeded. */
export function seedSampleIfEmpty(db: Db): boolean {
  if (db.select({ id: households.id }).from(households).limit(1).get()) return false;
  // Seeding needs no background jobs; a throwaway Services with the default executor is never asked to run one.
  new Services(db).households.importDocument(createSampleDocument(), {
    kind: "system",
    label: "sample seed",
  });
  return true;
}
