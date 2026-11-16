import { SCHEMA_VERSION, UserSettings } from "@glideworth/core";
import { eq } from "drizzle-orm";
import { userSettings } from "../db/schema.js";
import { mergePatch, nowIso } from "../util.js";
import type { ServiceCtx } from "./context.js";

export class SettingsService {
  constructor(private readonly ctx: ServiceCtx) {}

  get(): UserSettings {
    const row = this.ctx.db.select().from(userSettings).where(eq(userSettings.id, "default")).get();
    return UserSettings.parse(row?.body ?? {});
  }

  put(settings: unknown): UserSettings {
    const body = UserSettings.parse(settings);
    this.ctx.db
      .insert(userSettings)
      .values({ id: "default", schemaVersion: SCHEMA_VERSION, body })
      .onConflictDoUpdate({ target: userSettings.id, set: { body, updatedAt: nowIso() } })
      .run();
    return body;
  }

  patch(patch: unknown): UserSettings {
    return this.put(mergePatch(this.get(), patch));
  }
}
