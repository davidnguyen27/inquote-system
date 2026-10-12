import { createHash, createHmac } from "node:crypto";
import { isUUID } from "class-validator";
import type { AppConfig } from "../../config/env.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { HttpProblem } from "../../http/problem.js";
import { AuthRepository, type SessionContext } from "../auth/auth.repository.js";
import { operationSummary } from "../auth/auth.mapper.js";
import { OperationReceiptService } from "../auth/operation-receipt.service.js";
import { SessionService, equalBytes, tokenBytes } from "../auth/security.js";

export type WriteHeaders = { epoch: string | undefined; key: string | undefined; precondition: string | undefined };
type Intent = { kind: string; method: "PUT" | "POST"; route: string; body: Prisma.InputJsonObject };
type Applied = { resourceIds: Prisma.InputJsonObject; appliedRevisions: Prisma.InputJsonObject };
export function resourceETag(kind: "company" | "catalog", id: string | number, revision: number, epoch: string): string {
  return '"' + createHash("sha256").update(JSON.stringify([epoch,kind,id,revision])).digest("base64url") + '"';
}
export function text(value: string | null, pointer: string, max: number, required = false): string | null {
  const normalized = value?.trim() || null;
  if ((required && !normalized) || (normalized && (invalidText(normalized) || [...normalized].length > max)))
    throw new HttpProblem(422,"VALIDATION_FAILED",[{pointer,code:"INVALID_TEXT",message:`Use ${required ? "1" : "0"}–${max} characters.`}]);
  return normalized;
}
export function invalidText(value: string): boolean {
  // PostgreSQL rejects NUL; UTF-8 encoding would silently replace lone surrogates.
  return value.includes("\u0000") || /[\uD800-\uDFFF]/u.test(value);
}
export function requireId(id: string): string {
  if (!isUUID(id)) throw new HttpProblem(400,"INVALID_REQUEST");
  return id.toLowerCase();
}

// Exclusive actor locking serializes actor/key reservations before any resource lock.
export class CommonMutationService {
  constructor(private readonly config: AppConfig, private readonly auth: AuthRepository,
    private readonly security: SessionService, private readonly receipts: OperationReceiptService) {}
  authorize(token: string | undefined) {
    return this.auth.withSession(token,{allowLimited:false},async () => {});
  }
  write(token: string | undefined, csrf: string | undefined, headers: WriteHeaders, intent: Intent,
    apply: (context: SessionContext, precondition: string) => Promise<Applied>) {
    return this.auth.withSession(token,{allowLimited:false,exclusiveStaff:true},async context => {
      if (context.staff.role !== "ADMINISTRATOR") throw new HttpProblem(403,"FORBIDDEN");
      if (!this.security.validCsrf(context.token,csrf)) throw new HttpProblem(403,"FORBIDDEN");
      this.receipts.requireEpoch(headers.epoch);
      if (!headers.key || !isUUID(headers.key)) throw new HttpProblem(400,"IDEMPOTENCY_KEY_REQUIRED");
      const precondition = headers.precondition ?? "";
      if (intent.method === "PUT" && !/^"[^"\r\n]+"$/.test(precondition)) throw new HttpProblem(428,"PRECONDITION_REQUIRED");
      const existing = await this.receipts.existing(context,headers.key);
      if (existing) {
        if (existing.kind !== intent.kind || !equalBytes(existing.fingerprint,this.fingerprint(existing.fingerprintKeyId,intent,precondition)))
          throw new HttpProblem(409,"IDEMPOTENCY_KEY_REUSED");
        return {operation:operationSummary(existing)};
      }
      const applied = await apply(context,precondition);
      const receipt = await context.tx.operationReceipt.create({data:{
        actorId:context.staff.id,idempotencyKey:headers.key,
        fingerprint:new Uint8Array(this.fingerprint(this.config.operationKeyId,intent,precondition)),
        fingerprintKeyId:this.config.operationKeyId,recoveryEpoch:this.config.recoveryEpoch,
        kind:intent.kind,method:intent.method,route:intent.route,target:applied.resourceIds,
        ...applied,committedAt:context.now,
      }});
      return {operation:operationSummary(receipt)};
    });
  }
  private fingerprint(keyId: string, intent: Intent, precondition: string): Buffer {
    const key = this.config.operationKeys.get(keyId);
    if (!key) throw new HttpProblem(503,"SERVICE_UNAVAILABLE");
    return createHmac("sha256",key).update(JSON.stringify([this.config.recoveryEpoch,intent.method,intent.route,intent.body,precondition])).digest();
  }
}

export class CatalogCursor {
  constructor(private readonly config: AppConfig) {}
  create(filter: (string | number)[], name: string, id: string): string {
    const key=this.config.operationKeys.get(this.config.operationKeyId);
    if (!key) throw new HttpProblem(503,"SERVICE_UNAVAILABLE");
    const payload=Buffer.from(JSON.stringify([this.config.operationKeyId,this.config.recoveryEpoch,filter,name,id])).toString("base64url");
    return payload+"."+createHmac("sha256",key).update("catalog-name-id-asc:"+payload).digest("base64url");
  }
  read(cursor: string, filter: (string | number)[]): [string,string] {
    try {
      // Maximum name/search each contain 200 code points, including JSON escaping.
      if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) throw Error();
      const [payload,signature]=cursor.split(".") as [string,string];
      const value: unknown=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));
      if (!Array.isArray(value) || value.length!==5 || typeof value[0]!=="string" || value[1]!==this.config.recoveryEpoch ||
        JSON.stringify(value[2])!==JSON.stringify(filter) || typeof value[3]!=="string" || [...value[3]].length>200 || typeof value[4]!=="string" || !isUUID(value[4])) throw Error();
      const key=this.config.operationKeys.get(value[0]);
      if (!key || !equalBytes(tokenBytes(signature),createHmac("sha256",key).update("catalog-name-id-asc:"+payload).digest())) throw Error();
      return [value[3],value[4]];
    } catch { throw new HttpProblem(400,"INVALID_REQUEST"); }
  }
}
