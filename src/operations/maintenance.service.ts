import {Prisma,type StaffUser,type StaffSession} from '../generated/prisma/client.js';
import type {AppConfig} from '../config/env.js';
import {Database} from '../database/prisma.js';
import {HttpProblem} from '../http/problem.js';
import {ViewingTokens} from '../modules/quotations/publication-security.js';

export class MaintenanceService {
  private readonly tokens:ViewingTokens;
  constructor(private readonly config:AppConfig,private readonly database:Database){this.tokens=new ViewingTokens(config);}
  private bound(limit:number):number {
    if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new HttpProblem(400,'INVALID_REQUEST');
    return limit;
  }
  private async clock(tx:Prisma.TransactionClient):Promise<Date>{
    const [row]=await tx.$queryRaw<{now:Date}[]>`SELECT clock_timestamp() AS now`;return row!.now;
  }
  private unusable(staff:StaffUser,session:StaffSession,now:Date):boolean {
    return !staff.enabled||!!session.revokedAt||session.recoveryEpoch!==this.config.recoveryEpoch||now>=session.absoluteExpiresAt||now.getTime()-session.lastSeenAt.getTime()>=30*60000||
      (staff.mustChangePassword&&(!staff.temporaryCredentialExpiresAt||now>=staff.temporaryCredentialExpiresAt));
  }
  private async sessionWork(id:string,staffId:string,revoke:boolean):Promise<boolean> {
    return this.database.transaction(async tx=>{
      // Domain authorization locks staff before sessions; do not wait on active users.
      const staffRows=await tx.$queryRaw<{id:string}[]>(revoke?Prisma.sql`SELECT id FROM staff_user WHERE id=${staffId}::uuid FOR UPDATE SKIP LOCKED`:Prisma.sql`SELECT id FROM staff_user WHERE id=${staffId}::uuid FOR SHARE SKIP LOCKED`);
      if(!staffRows.length)return false;
      const sessionRows=await tx.$queryRaw<{id:string}[]>`SELECT id FROM staff_session WHERE id=${id}::uuid FOR UPDATE SKIP LOCKED`;if(!sessionRows.length)return false;
      const staff=await tx.staffUser.findUnique({where:{id:staffId}}),session=await tx.staffSession.findUnique({where:{id}}),now=await this.clock(tx);
      if(!staff||!session)return false;
      if(revoke){if(session.revokedAt)return false;await tx.staffSession.update({where:{id},data:{revokedAt:now}});return true;}
      if(!this.unusable(staff,session,now))return false;
      await tx.staffSession.delete({where:{id}});return true;
    });
  }
  async housekeeping(limit=100){
    this.bound(limit);
    const rateBucketsDeleted=await this.database.transaction(async tx=>tx.$executeRaw`
      WITH expired AS (
        SELECT scope,key_digest,window_start FROM rate_limit_bucket
        WHERE expires_at<=clock_timestamp() ORDER BY expires_at,scope,key_digest,window_start LIMIT ${limit} FOR UPDATE SKIP LOCKED
      ) DELETE FROM rate_limit_bucket b USING expired e
      WHERE b.scope=e.scope AND b.key_digest=e.key_digest AND b.window_start=e.window_start AND b.expires_at<=clock_timestamp()`);
    const sessions=await this.database.client.$queryRaw<{id:string;staffId:string}[]>`
      SELECT s.id,s.staff_id AS "staffId" FROM staff_session s JOIN staff_user u ON u.id=s.staff_id
      WHERE s.revoked_at IS NOT NULL OR s.recovery_epoch<>${this.config.recoveryEpoch}::uuid OR s.absolute_expires_at<=clock_timestamp()
        OR s.last_seen_at<=clock_timestamp()-interval '30 minutes' OR NOT u.enabled
        OR (u.must_change_password AND (u.temporary_credential_expires_at IS NULL OR u.temporary_credential_expires_at<=clock_timestamp()))
      ORDER BY s.staff_id,s.id LIMIT ${limit}`;
    let sessionsDeleted=0;for(const row of sessions)if(await this.sessionWork(row.id,row.staffId,false))sessionsDeleted++;
    const now=await this.database.transaction(tx=>this.clock(tx));
    const access=await this.database.client.viewingAccess.findMany({where:{expiresAt:{lte:now},tokenCiphertext:{not:null}},select:{quotationId:true},orderBy:{quotationId:'asc'},take:limit});
    let expiredCiphertextsCleared=0;
    for(const row of access){
      const changed=await this.database.transaction(async tx=>{
        const quotes=await tx.$queryRaw<{id:string}[]>`SELECT id FROM quotation WHERE id=${row.quotationId}::uuid FOR UPDATE SKIP LOCKED`;if(!quotes.length)return false;
        const grants=await tx.$queryRaw<{quotation_id:string}[]>`SELECT quotation_id FROM viewing_access WHERE quotation_id=${row.quotationId}::uuid FOR UPDATE SKIP LOCKED`;if(!grants.length)return false;
        const current=await tx.viewingAccess.findUnique({where:{quotationId:row.quotationId}}),clock=await this.clock(tx);
        if(!current?.tokenCiphertext||clock<current.expiresAt)return false;
        await tx.viewingAccess.update({where:{quotationId:row.quotationId},data:{tokenCiphertext:null,tokenNonce:null,tokenTag:null,encryptionKeyId:null}});return true;
      });if(changed)expiredCiphertextsCleared++;
    }
    return {rateBucketsDeleted,sessionsDeleted,expiredCiphertextsCleared,scannedSessions:sessions.length,scannedAccess:access.length};
  }
  async auditKeys(){
    const operation=await this.database.client.operationReceipt.groupBy({by:['fingerprintKeyId'],_count:{_all:true},orderBy:{fingerprintKeyId:'asc'}});
    // Any remaining ciphertext, including expired material, still references its decryption key.
    const viewing=await this.database.client.viewingAccess.groupBy({by:['encryptionKeyId'],where:{tokenCiphertext:{not:null}},_count:{_all:true},orderBy:{encryptionKeyId:'asc'}});
    const operationKeys=operation.map(row=>({keyId:row.fingerprintKeyId,receiptCount:row._count._all,configured:this.config.operationKeys.has(row.fingerprintKeyId)}));
    const viewingKeys=viewing.map(row=>({keyId:row.encryptionKeyId,grantCount:row._count._all,configured:!!row.encryptionKeyId&&this.config.viewingKeys.has(row.encryptionKeyId)}));
    const missingOperationKeyIds=operationKeys.filter(row=>!row.configured).map(row=>row.keyId),missingViewingKeyIds=viewingKeys.filter(row=>!row.configured).map(row=>row.keyId);
    return {currentOperationKeyId:this.config.operationKeyId,currentViewingKeyId:this.config.viewingKeyId,operationKeys,viewingKeys,missingOperationKeyIds,missingViewingKeyIds,safe:!missingOperationKeyIds.length&&!missingViewingKeyIds.length};
  }
  async reencryptViewing(limit=100){
    this.bound(limit);const now=await this.database.transaction(tx=>this.clock(tx));
    const candidates=await this.database.client.viewingAccess.findMany({where:{encryptionKeyId:{not:this.config.viewingKeyId},tokenCiphertext:{not:null},revokedAt:null,expiresAt:{gt:now}},select:{quotationId:true},orderBy:{quotationId:'asc'},take:limit});
    let reencrypted=0;
    for(const row of candidates){
      const changed=await this.database.transaction(async tx=>{
        const quotes=await tx.$queryRaw<{id:string}[]>`SELECT id FROM quotation WHERE id=${row.quotationId}::uuid FOR UPDATE SKIP LOCKED`;if(!quotes.length)return false;
        const grants=await tx.$queryRaw<{quotation_id:string}[]>`SELECT quotation_id FROM viewing_access WHERE quotation_id=${row.quotationId}::uuid FOR UPDATE SKIP LOCKED`;if(!grants.length)return false;
        const quote=await tx.quotation.findUnique({where:{id:row.quotationId}}),current=await tx.viewingAccess.findUnique({where:{quotationId:row.quotationId}}),clock=await this.clock(tx);
        if(!quote||!current?.tokenCiphertext||current.revokedAt||clock>=current.expiresAt||current.versionId!==quote.latestSharedVersionId||current.encryptionKeyId===this.config.viewingKeyId)return false;
        // This only changes encrypted representation; token/hash, generation, expiry and ETag stay fixed.
        const encrypted=this.tokens.reencrypt(current);
        await tx.viewingAccess.update({where:{quotationId:row.quotationId},data:{tokenCiphertext:encrypted.tokenCiphertext,tokenNonce:encrypted.tokenNonce,tokenTag:encrypted.tokenTag,encryptionKeyId:encrypted.encryptionKeyId}});return true;
      });if(changed)reencrypted++;
    }
    return {scanned:candidates.length,reencrypted,skipped:candidates.length-reencrypted};
  }
  async revokeSessions(limit=100){
    this.bound(limit);const rows=await this.database.client.staffSession.findMany({where:{revokedAt:null},select:{id:true,staffId:true},orderBy:[{staffId:'asc'},{id:'asc'}],take:limit});
    let sessionsRevoked=0;for(const row of rows)if(await this.sessionWork(row.id,row.staffId,true))sessionsRevoked++;
    return {scanned:rows.length,sessionsRevoked,skipped:rows.length-sessionsRevoked};
  }
}
