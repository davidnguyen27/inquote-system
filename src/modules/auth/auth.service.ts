import { isEmail, isUUID } from "class-validator";
import type { AppConfig } from "../../config/env.js";
import { HttpProblem } from "../../http/problem.js";
import { AuthRepository, type SessionContext } from "./auth.repository.js";
import { PasswordService } from "./password.service.js";
import { SessionService, staffETag } from "./security.js";
import { OperationReceiptService } from "./operation-receipt.service.js";
import { authSummary, operationSummary } from "./auth.mapper.js";
import type { ChangePasswordDto, LoginDto } from "./auth.dto.js";

export class AuthService {
  constructor(
    private readonly config: AppConfig,
    private readonly repository: AuthRepository,
    private readonly passwords: PasswordService,
    private readonly security: SessionService,
    private readonly receipts: OperationReceiptService,
  ) {}
  async login(body: LoginDto) {
    const email = body.email?.trim().toLowerCase() ?? "",
      password = body.password ?? "";
    const observed =
      email.length <= 254 && isEmail(email)
        ? await this.repository.database.client.staffUser.findUnique({
            where: { normalizedEmail: email },
          })
        : null;
    let valid = false;
    if (observed)
      valid = await this.passwords.verify(observed.passwordHash, password);
    else await this.passwords.dummyVerify(password);
    if (!observed || !valid) throw new HttpProblem(401, "INVALID_CREDENTIALS");
    const token = this.security.issue();
    return this.repository.database.transaction(async (tx) => {
      const staff = await this.repository.lockStaff(tx, observed.id, false);
      const now = await this.repository.clock(tx);
      if (
        !staff?.enabled ||
        staff.revision !== observed.revision ||
        staff.passwordHash !== observed.passwordHash ||
        (staff.mustChangePassword &&
          (!staff.temporaryCredentialExpiresAt ||
            now >= staff.temporaryCredentialExpiresAt))
      ) {
        throw new HttpProblem(401, "INVALID_CREDENTIALS");
      }
      const expires = Math.min(
        now.getTime() + 8 * 60 * 60 * 1000,
        staff.mustChangePassword
          ? staff.temporaryCredentialExpiresAt!.getTime()
          : Infinity,
      );
      const session = await tx.staffSession.create({
        data: {
          staffId: staff.id,
          tokenHash: this.security.digest(token),
          recoveryEpoch: this.config.recoveryEpoch,
          createdAt: now,
          lastSeenAt: now,
          absoluteExpiresAt: new Date(expires),
        },
      });
      return {
        token,
        summary: authSummary(
          { tx, staff, session, now, token },
          this.security,
          this.config.recoveryEpoch,
        ),
      };
    });
  }
  inspect(token: string | undefined) {
    return this.repository.withSession(
      token,
      { allowLimited: true },
      async (context) =>
        authSummary(context, this.security, this.config.recoveryEpoch),
    );
  }
  async logout(
    token: string | undefined,
    csrf: string | undefined,
  ): Promise<void> {
    try {
      await this.repository.withSession(
        token,
        { allowLimited: true },
        async (context) => {
          if (!this.security.validCsrf(context.token, csrf))
            throw new HttpProblem(403, "FORBIDDEN");
          await context.tx.staffSession.update({
            where: { id: context.session.id },
            data: { revokedAt: context.now },
          });
        },
      );
    } catch (error) {
      if (!(error instanceof HttpProblem && error.code === "SESSION_REQUIRED"))
        throw error;
    }
  }
  async changePassword(
    token: string | undefined,
    csrf: string | undefined,
    body: ChangePasswordDto,
    headers: {
      epoch?: string | undefined;
      key?: string | undefined;
      precondition?: string | undefined;
    },
  ) {
    // Authenticate cheaply first, release locks for Argon2, then recheck every guard before committing.
    const preliminary = await this.repository.withSession(
      token,
      { allowLimited: true },
      async (context) => {
        const { key } = this.passwordIntent(context, csrf, headers);
        return {
          staff: context.staff,
          receipt: await this.receipts.existing(context, key),
        };
      },
    );
    const observed = preliminary.staff;
    let currentValid = false,
      newHash: string | undefined,
      policyFailure: unknown;
    if (!preliminary.receipt) {
      currentValid = await this.passwords.verify(
        observed.passwordHash,
        body.currentPassword,
      );
      try {
        this.passwords.validate(body.newPassword);
      } catch (error) {
        policyFailure = error;
      }
      if (currentValid && !policyFailure)
        newHash = await this.passwords.hash(body.newPassword);
    }
    return this.repository.withSession(
      token,
      { allowLimited: true, exclusiveStaff: true },
      async (context) => {
        const { key, precondition } = this.passwordIntent(
          context,
          csrf,
          headers,
        );
        const previous = await this.receipts.existing(context, key);
        if (previous) {
          if (previous.kind !== "CHANGE_PASSWORD")
            throw new HttpProblem(409, "IDEMPOTENCY_KEY_REUSED");
          this.receipts.verifyIntent(
            previous.fingerprintKeyId,
            previous.fingerprint,
            body,
            precondition,
          );
          return { operation: operationSummary(previous), replayed: true };
        }
        if (
          precondition !==
            staffETag(
              context.staff.id,
              context.staff.revision,
              this.config.recoveryEpoch,
            ) ||
          !observed ||
          observed.revision !== context.staff.revision ||
          observed.passwordHash !== context.staff.passwordHash
        ) {
          throw new HttpProblem(412, "REVISION_CONFLICT");
        }
        if (!currentValid) throw new HttpProblem(401, "INVALID_CREDENTIALS");
        if (policyFailure) throw policyFailure;
        if (!newHash) throw new HttpProblem(503, "SERVICE_UNAVAILABLE");
        const updated = await context.tx.staffUser.update({
          where: { id: context.staff.id },
          data: {
            passwordHash: newHash,
            mustChangePassword: false,
            temporaryCredentialExpiresAt: null,
            revision: { increment: 1 },
          },
        });
        await context.tx.staffSession.updateMany({
          where: { staffId: context.staff.id, revokedAt: null },
          data: { revokedAt: context.now },
        });
        const receipt = await this.receipts.create(
          context,
          key,
          body,
          precondition,
          updated.revision,
        );
        return { operation: operationSummary(receipt), replayed: false };
      },
    );
  }
  private passwordIntent(
    context: SessionContext,
    csrf: string | undefined,
    headers: {
      epoch?: string | undefined;
      key?: string | undefined;
      precondition?: string | undefined;
    },
  ) {
    if (!this.security.validCsrf(context.token, csrf))
      throw new HttpProblem(403, "FORBIDDEN");
    this.receipts.requireEpoch(headers.epoch);
    if (!headers.key || !isUUID(headers.key))
      throw new HttpProblem(400, "IDEMPOTENCY_KEY_REQUIRED");
    if (!headers.precondition || !/^"[^"\r\n]+"$/.test(headers.precondition))
      throw new HttpProblem(428, "PRECONDITION_REQUIRED");
    return { key: headers.key, precondition: headers.precondition };
  }
  operation(token: string | undefined, key: string, epoch: string | undefined) {
    return this.repository.withSession(
      token,
      { allowLimited: true },
      async (context) => {
        this.receipts.requireEpoch(epoch);
        if (!isUUID(key)) throw new HttpProblem(400, "INVALID_REQUEST");
        const receipt = await this.receipts.existing(context, key);
        if (!receipt)
          throw new HttpProblem(404, "OPERATION_UNKNOWN");
        if (["CREATE_QUOTATION", "SAVE_DRAFT", "DISCARD_DRAFT", "CREATE_REVISION", "REUSE_DRAFT", "SHARE_QUOTATION", "REVOKE_ACCESS", "REPLACE_ACCESS"].includes(receipt.kind)) {
          const target=receipt.target;
          if(context.staff.mustChangePassword||!target||typeof target!=="object"||Array.isArray(target)||typeof target.quotationId!=="string"||!isUUID(target.quotationId))throw new HttpProblem(404,"OPERATION_UNKNOWN");
          await context.tx.$queryRaw`SELECT id FROM quotation WHERE id=${target.quotationId}::uuid AND (${context.staff.role==="ADMINISTRATOR"} OR owner_id=${context.staff.id}::uuid) FOR SHARE`;
          const retained=await context.tx.quotation.findFirst({where:{id:target.quotationId,...(context.staff.role==="ADMINISTRATOR"?{}:{ownerId:context.staff.id})},select:{id:true}});
          if(!retained)throw new HttpProblem(404,"OPERATION_UNKNOWN");
        } else if (receipt.kind !== "CHANGE_PASSWORD") {
          if (context.staff.mustChangePassword || context.staff.role !== "ADMINISTRATOR" ||
            !["CREATE_EMPLOYEE", "UPDATE_EMPLOYEE", "RESET_EMPLOYEE_CREDENTIAL", "UPDATE_COMPANY", "CREATE_CATALOG_ITEM", "UPDATE_CATALOG_ITEM"].includes(receipt.kind))
            throw new HttpProblem(404, "OPERATION_UNKNOWN");
          const target = receipt.target;
          if (!target || typeof target !== "object" || Array.isArray(target))
            throw new HttpProblem(404, "OPERATION_UNKNOWN");
          let retained = false;
          if (receipt.kind === "UPDATE_COMPANY") {
            retained = target.companyId === 1 && !!await context.tx.companyProfile.findUnique({where:{id:1},select:{id:true}});
          } else if (receipt.kind === "CREATE_CATALOG_ITEM" || receipt.kind === "UPDATE_CATALOG_ITEM") {
            retained = typeof target.catalogItemId === "string" && isUUID(target.catalogItemId) &&
              !!await context.tx.catalogItem.findUnique({where:{id:target.catalogItemId},select:{id:true}});
          } else {
            retained = typeof target.staffId === "string" && isUUID(target.staffId) &&
              !!await context.tx.staffUser.findFirst({where:{id:target.staffId,role:"EMPLOYEE"},select:{id:true}});
          }
          if (!retained) throw new HttpProblem(404, "OPERATION_UNKNOWN");
        }
        return operationSummary(receipt);
      },
    );
  }
}
