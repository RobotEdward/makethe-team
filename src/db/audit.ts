import type { AuditAction, AuditEntityType } from "../domain/audit.js";
import type { Db } from "./client.js";
import { auditLog } from "./schema.js";

/**
 * A single write to `audit_log` (BR-27, §2.8).
 *
 * Every Owner override and lifecycle change is recorded here with an actor,
 * a timestamp and the previous value, so this is the one place that inserts
 * into the table — callers describe *what happened*, not how to serialise it.
 */
export interface AuditEntry {
  /** Null for cron and other system actions, which have no actor. */
  actorPlayerId: string | null;
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  before?: unknown;
  after?: unknown;
  now: Date;
}

/** Record one `audit_log` row. `before`/`after` are serialised to JSON. */
export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    id: crypto.randomUUID(),
    actorPlayerId: entry.actorPlayerId,
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    beforeJson: entry.before === undefined ? null : JSON.stringify(entry.before),
    afterJson: entry.after === undefined ? null : JSON.stringify(entry.after),
    createdAt: entry.now,
  });
}
