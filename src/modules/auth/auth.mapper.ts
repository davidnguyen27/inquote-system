import type { SessionContext } from "./auth.repository.js";
import type { OperationReceipt } from "../../generated/prisma/client.js";
import { SessionService, staffETag } from "./security.js";

export function authSummary(
  context: SessionContext,
  security: SessionService,
  epoch: string,
) {
  const { staff, session, now, token } = context;
  return {
    staff: {
      id: staff.id,
      displayName: staff.displayName,
      email: staff.normalizedEmail,
      role: staff.role,
    },
    staffETag: staffETag(staff.id, staff.revision, epoch),
    mustChangePassword: staff.mustChangePassword,
    csrfToken: security.csrf(token),
    recoveryEpoch: epoch,
    serverTime: now.toISOString(),
    idleExpiresAt: new Date(
      Math.min(
        now.getTime() + 30 * 60 * 1000,
        session.absoluteExpiresAt.getTime(),
      ),
    ).toISOString(),
    absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
  };
}
export function operationSummary(receipt: OperationReceipt) {
  return {
    key: receipt.idempotencyKey,
    kind: receipt.kind,
    recoveryEpoch: receipt.recoveryEpoch,
    resourceIds: receipt.resourceIds,
    appliedRevisions: receipt.appliedRevisions,
    committedAt: receipt.committedAt.toISOString(),
    ...(receipt.accessGeneration?{accessGeneration:receipt.accessGeneration}:{}),
  };
}
