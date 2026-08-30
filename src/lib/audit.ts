import { auditEvents } from "@/db/schema";
import { db } from "@/db";

export type DbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type AuditEventInput = {
  actorUserId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  action: string;
  metadata: Record<string, unknown>;
};

export async function recordAuditEvent(
  executor: DbExecutor,
  input: AuditEventInput,
): Promise<void> {
  await executor.insert(auditEvents).values({
    actorUserId: input.actorUserId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    action: input.action,
    metadata: input.metadata,
  });
}
