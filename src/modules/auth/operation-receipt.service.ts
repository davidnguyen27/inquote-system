import type { AppConfig } from "../../config/env.js";
import type { SessionContext } from "./auth.repository.js";
import { HttpProblem } from "../../http/problem.js";
import { equalBytes, fingerprint } from "./security.js";

export class OperationReceiptService {
  constructor(private readonly config: AppConfig) {}
  requireEpoch(epoch: string | undefined): void {
    if (epoch !== this.config.recoveryEpoch)
      throw new HttpProblem(409, "RECOVERY_REQUIRED");
  }
  async existing(context: SessionContext, key: string) {
    const receipt = await context.tx.operationReceipt.findUnique({
      where: {
        actorId_idempotencyKey: {
          actorId: context.staff.id,
          idempotencyKey: key,
        },
      },
    });
    if (receipt && receipt.recoveryEpoch !== this.config.recoveryEpoch)
      throw new HttpProblem(409, "RECOVERY_REQUIRED");
    return receipt;
  }
  verifyIntent(
    keyId: string,
    stored: Uint8Array,
    body: { currentPassword: string; newPassword: string },
    precondition: string,
  ): void {
    const key = this.config.operationKeys.get(keyId);
    if (!key) throw new HttpProblem(503, "SERVICE_UNAVAILABLE");
    if (
      !equalBytes(
        stored,
        fingerprint(key, this.config.recoveryEpoch, body, precondition),
      )
    )
      throw new HttpProblem(409, "IDEMPOTENCY_KEY_REUSED");
  }
  create(
    context: SessionContext,
    idempotencyKey: string,
    body: { currentPassword: string; newPassword: string },
    precondition: string,
    revision: number,
  ) {
    return context.tx.operationReceipt.create({
      data: {
        actorId: context.staff.id,
        idempotencyKey,
        fingerprint: fingerprint(
          this.config.operationKeys.get(this.config.operationKeyId)!,
          this.config.recoveryEpoch,
          body,
          precondition,
        ),
        fingerprintKeyId: this.config.operationKeyId,
        recoveryEpoch: this.config.recoveryEpoch,
        kind: "CHANGE_PASSWORD",
        method: "POST",
        route: "/api/v1/auth/change-password",
        target: { staffId: context.staff.id },
        resourceIds: { staffId: context.staff.id },
        appliedRevisions: { staff: revision },
        committedAt: context.now,
      },
    });
  }
}
