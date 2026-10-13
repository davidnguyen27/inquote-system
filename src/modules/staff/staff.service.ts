import { createHmac } from "node:crypto";
import { isUUID } from "class-validator";
import type { AppConfig } from "../../config/env.js";
import { Prisma } from "../../generated/prisma/client.js";
import { HttpProblem } from "../../http/problem.js";
import { AuthRepository, type SessionContext } from "../auth/auth.repository.js";
import { OperationReceiptService } from "../auth/operation-receipt.service.js";
import { operationSummary } from "../auth/auth.mapper.js";
import { PasswordService } from "../auth/password.service.js";
import { RateLimitService } from "../auth/rate-limit.service.js";
import { SessionService, equalBytes, staffETag, tokenBytes } from "../auth/security.js";
import { StaffRepository } from "./staff.repository.js";
import { StaffMapper } from "./staff.mapper.js";
import { validateText } from '../../domain/text.js';
import { emailField, textField } from '../../http/text-validation.js';
import type { StaffCreateDto, StaffListDto, StaffResetDto, StaffUpdateDto } from "./staff.dto.js";

type Headers = { epoch: string | undefined; key: string | undefined; precondition: string | undefined };
type Intent = { kind: "CREATE_EMPLOYEE"; body: StaffCreateDto } |
  { kind: "UPDATE_EMPLOYEE"; id: string; body: StaffUpdateDto } |
  { kind: "RESET_EMPLOYEE_CREDENTIAL"; id: string; body: StaffResetDto };

export class StaffService {
  private readonly mapper: StaffMapper;
  constructor(private readonly config: AppConfig, private readonly auth: AuthRepository,
    private readonly repository: StaffRepository, private readonly passwords: PasswordService,
    private readonly security: SessionService, private readonly receipts: OperationReceiptService,
    private readonly limits: RateLimitService) { this.mapper = new StaffMapper(config.recoveryEpoch); }

  private administrator(context: SessionContext): void {
    if (context.staff.role !== "ADMINISTRATOR") throw new HttpProblem(403, "FORBIDDEN");
  }
  authorize(token: string | undefined) {
    return this.auth.withSession(token, { allowLimited: false }, async context => this.administrator(context));
  }
  list(token: string | undefined, query: StaffListDto) {
    return this.auth.withSession(token, { allowLimited: false }, async context => {
      this.administrator(context);
      const limit = Number(query.limit ?? "25"), parsed = validateText(query.search ?? "", { maxCodePoints: 200 });
      if (!/^[1-9]\d*$/.test(query.limit ?? "25") || limit > 100 || !parsed.ok ||
        (query.enabled !== undefined && !["true", "false"].includes(query.enabled))) throw new HttpProblem(400, "INVALID_REQUEST");
      const search = parsed.value ?? "";
      const filter = [search, query.enabled ?? "", limit];
      const where: Prisma.StaffUserWhereInput = { AND: [
        ...(search ? [{ OR: [{ displayName: { contains: search, mode: "insensitive" as const } },
          { normalizedEmail: { contains: search.toLowerCase() } }] }] : []),
        ...(query.enabled === undefined ? [] : [{ enabled: query.enabled === "true" }]),
      ] };
      if (query.cursor !== undefined) {
        const [name, id] = this.readCursor(query.cursor, filter);
        (where.AND as Prisma.StaffUserWhereInput[]).push({ OR: [
          { displayName: { gt: name } }, { displayName: name, id: { gt: id } },
        ] });
      }
      const rows = await this.repository.list(context.tx, where, limit), items = rows.slice(0, limit);
      const last = items.at(-1);
      return { items: items.map(row => this.mapper.read(row)), nextCursor: rows.length > limit && last ? this.cursor(filter, last.displayName, last.id) : null };
    });
  }
  read(token: string | undefined, id: string) {
    this.id(id);
    id = id.toLowerCase();
    return this.auth.withSession(token, { allowLimited: false, staffIds: [id] }, async context => {
      this.administrator(context);
      const staff = await this.repository.employee(context.tx, id);
      if (!staff) throw new HttpProblem(404, "NOT_FOUND");
      return this.mapper.read(staff);
    });
  }
  create(token: string | undefined, csrf: string | undefined, body: StaffCreateDto, headers: Headers) {
    return this.write(token, csrf, { kind: "CREATE_EMPLOYEE", body }, headers);
  }
  update(token: string | undefined, csrf: string | undefined, id: string, body: StaffUpdateDto, headers: Headers) {
    this.id(id); return this.write(token, csrf, { kind: "UPDATE_EMPLOYEE", id: id.toLowerCase(), body }, headers);
  }
  reset(token: string | undefined, csrf: string | undefined, id: string, body: StaffResetDto, headers: Headers) {
    this.id(id); return this.write(token, csrf, { kind: "RESET_EMPLOYEE_CREDENTIAL", id: id.toLowerCase(), body }, headers);
  }
  private id(id: string): void { if (!isUUID(id)) throw new HttpProblem(400, "INVALID_REQUEST"); }
  private guards(context: SessionContext, csrf: string | undefined, headers: Headers, intent: Intent) {
    this.administrator(context);
    if (!this.security.validCsrf(context.token, csrf)) throw new HttpProblem(403, "FORBIDDEN");
    this.receipts.requireEpoch(headers.epoch);
    if (!headers.key || !isUUID(headers.key)) throw new HttpProblem(400, "IDEMPOTENCY_KEY_REQUIRED");
    const precondition = headers.precondition ?? "";
    if (intent.kind !== "CREATE_EMPLOYEE" && !/^"[^"\r\n]+"$/.test(precondition)) throw new HttpProblem(428, "PRECONDITION_REQUIRED");
    return { key: headers.key, precondition };
  }
  private route(intent: Intent) {
    return intent.kind === "CREATE_EMPLOYEE" ? "/api/v1/staff" : `/api/v1/staff/${intent.id}${intent.kind === "RESET_EMPLOYEE_CREDENTIAL" ? "/credential-reset" : ""}`;
  }
  private body(intent: Intent): Prisma.InputJsonObject {
    if (intent.kind === "CREATE_EMPLOYEE") return { displayName: intent.body.displayName, email: intent.body.email, temporaryPassword: intent.body.temporaryPassword };
    if (intent.kind === "UPDATE_EMPLOYEE") return { displayName: intent.body.displayName, enabled: intent.body.enabled };
    return { temporaryPassword: intent.body.temporaryPassword };
  }
  private fingerprint(keyId: string, intent: Intent, precondition: string): Buffer {
    const key = this.config.operationKeys.get(keyId);
    if (!key) throw new HttpProblem(503, "SERVICE_UNAVAILABLE");
    return createHmac("sha256", key).update(JSON.stringify([this.config.recoveryEpoch,
      intent.kind === "UPDATE_EMPLOYEE" ? "PUT" : "POST", this.route(intent), this.body(intent), precondition])).digest();
  }
  private replay(receipt: NonNullable<Awaited<ReturnType<OperationReceiptService["existing"]>>>, intent: Intent, precondition: string) {
    if (receipt.kind !== intent.kind || !equalBytes(receipt.fingerprint, this.fingerprint(receipt.fingerprintKeyId, intent, precondition)))
      throw new HttpProblem(409, "IDEMPOTENCY_KEY_REUSED");
    return { operation: operationSummary(receipt) };
  }
  private validate(intent: Intent): { displayName: string | null; email: string | null } {
    const displayName = intent.kind === "RESET_EMPLOYEE_CREDENTIAL" ? null : textField(intent.body.displayName, '/displayName', 200, true);
    const email = intent.kind === "CREATE_EMPLOYEE" ? emailField(intent.body.email, '/email', 'account') : null;
    if (intent.kind !== "UPDATE_EMPLOYEE") {
      try { tokenBytes(intent.body.temporaryPassword); } catch {
        throw new HttpProblem(422, "VALIDATION_FAILED", [{pointer:"/temporaryPassword", code:"INVALID_TEMPORARY_PASSWORD", message:"Supply a canonical base64url credential generated from 32 random bytes."}]);
      }
      this.passwords.validate(intent.body.temporaryPassword);
    }
    return { displayName, email };
  }
  private async write(token: string | undefined, csrf: string | undefined, intent: Intent, headers: Headers) {
    const previous = await this.auth.withSession(token, { allowLimited: false }, async context => {
      const {key, precondition} = this.guards(context, csrf, headers, intent);
      const receipt = await this.receipts.existing(context, key);
      return { receipt, precondition, actorId: context.staff.id };
    });
    if (previous.receipt) return this.replay(previous.receipt, intent, previous.precondition);
    const normalized = this.validate(intent);
    let hash: string | undefined;
    if (intent.kind !== "UPDATE_EMPLOYEE") {
      await this.limits.consume([{scope:"employee_credentials", identity:previous.actorId, limit:10, seconds:3600}]);
      hash = await this.passwords.hash(intent.body.temporaryPassword);
    }
    try {
      return await this.auth.withSession(token, { allowLimited: false, exclusiveStaff: true,
        staffIds: intent.kind === "CREATE_EMPLOYEE" ? [] : [intent.id] }, async context => {
        const {key, precondition} = this.guards(context, csrf, headers, intent);
        const receipt = await this.receipts.existing(context, key);
        if (receipt) return this.replay(receipt, intent, precondition);
        const target = intent.kind === "CREATE_EMPLOYEE" ? null : await this.repository.employee(context.tx, intent.id);
        if (intent.kind !== "CREATE_EMPLOYEE") {
          if (!target) throw new HttpProblem(404, "NOT_FOUND");
          if (precondition !== staffETag(target.id, target.revision, this.config.recoveryEpoch)) throw new HttpProblem(412, "REVISION_CONFLICT");
        }
        const staff = intent.kind === "CREATE_EMPLOYEE"
          ? await this.repository.create(context.tx, normalized.displayName!, normalized.email!, hash!, context.now)
          : intent.kind === "UPDATE_EMPLOYEE"
            ? await this.repository.update(context.tx, intent.id, normalized.displayName!, intent.body.enabled, context.now)
            : await this.repository.reset(context.tx, intent.id, hash!, context.now);
        if (intent.kind === "RESET_EMPLOYEE_CREDENTIAL" || (intent.kind === "UPDATE_EMPLOYEE" && !intent.body.enabled))
          await this.repository.revokeSessions(context.tx, staff.id, context.now);
        const committed = await context.tx.operationReceipt.create({data:{ actorId:context.staff.id, idempotencyKey:key,
          fingerprint:new Uint8Array(this.fingerprint(this.config.operationKeyId, intent, precondition)),
          fingerprintKeyId:this.config.operationKeyId, recoveryEpoch:this.config.recoveryEpoch, kind:intent.kind,
          method:intent.kind === "UPDATE_EMPLOYEE" ? "PUT" : "POST", route:this.route(intent), target:{staffId:staff.id},
          resourceIds:{staffId:staff.id}, appliedRevisions:{staff:staff.revision}, committedAt:context.now }});
        return {operation:operationSummary(committed)};
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && intent.kind === "CREATE_EMPLOYEE")
        throw new HttpProblem(409, "EMAIL_ALREADY_EXISTS");
      throw error;
    }
  }
  private cursor(filter: (string | number)[], name: string, id: string): string {
    const payload = Buffer.from(JSON.stringify([this.config.operationKeyId, this.config.recoveryEpoch, filter, name, id])).toString("base64url");
    return payload + "." + createHmac("sha256", this.config.operationKeys.get(this.config.operationKeyId)!).update("staff-cursor:" + payload).digest("base64url");
  }
  private readCursor(cursor: string, filter: (string | number)[]): [string, string] {
    try {
      // Includes two 200-code-point strings; JSON escaping can use six bytes per point.
      if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) throw Error();
      const [payload, signature] = cursor.split(".") as [string, string];
      const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (!Array.isArray(value) || value.length !== 5 || typeof value[0] !== "string" || value[1] !== this.config.recoveryEpoch ||
        JSON.stringify(value[2]) !== JSON.stringify(filter) || typeof value[3] !== "string" || [...value[3]].length > 200 || typeof value[4] !== "string" || !isUUID(value[4])) throw Error();
      const key = this.config.operationKeys.get(value[0]);
      if (!key || !equalBytes(tokenBytes(signature), createHmac("sha256",key).update("staff-cursor:"+payload).digest())) throw Error();
      return [value[3], value[4]];
    } catch { throw new HttpProblem(400, "INVALID_REQUEST"); }
  }
}
