import { EventEmitter } from "node:events";
import type { Db } from "../db/client.js";
import type { CoreDeps, ImportDeps } from "../deps.js";

export type WebhookEventName =
  | "plan.updated"
  | "simulation.completed"
  | "snapshot.created"
  | "snapshot.updated"
  | "checkin.completed"
  | "notification.created"
  | "webhook.ping";
export const WEBHOOK_EVENTS: WebhookEventName[] = [
  "plan.updated",
  "simulation.completed",
  "snapshot.created",
  "snapshot.updated",
  "checkin.completed",
  "notification.created",
  "webhook.ping",
];

export interface DomainEvent {
  name: WebhookEventName;
  data: Record<string, unknown>;
}

/** In-process event bus. Webhook delivery subscribes to it; services only emit. */
export class EventBus extends EventEmitter {
  publish(name: WebhookEventName, data: Record<string, unknown>): void {
    const ev: DomainEvent = { name, data };
    this.emit("event", ev);
  }
}

export interface ServiceCtx {
  db: Db;
  deps: CoreDeps;
  imports: ImportDeps;
  events: EventBus;
}
