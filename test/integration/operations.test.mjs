import assert from 'node:assert/strict';
import test,{beforeEach,after} from 'node:test';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Database} from '../../dist/database/prisma.js';
import {MaintenanceService} from '../../dist/operations/maintenance.service.js';
import {ViewingTokens} from '../../dist/modules/quotations/publication-security.js';
import {fixtureConfig,testUrl,key,epoch} from '../helpers.mjs';
if(!testUrl||!new URL(testUrl).pathname.endsWith('_test'))throw Error('Dedicated migrated TEST_DATABASE_URL ending _test required');
const db=new Database(testUrl),old=fixtureConfig(),config={...old,viewingKeyId:'v2',viewingKeys:new Map([...old.viewingKeys,['v2',Buffer.alloc(32,8)]])},service=new MaintenanceService(config,db);
let staff,clock;
beforeEach(async()=>{
 await db.client.$executeRawUnsafe('TRUNCATE TABLE quotation CASCADE');await db.client.operationReceipt.deleteMany();await db.client.staffSession.deleteMany();await db.client.rateLimitBucket.deleteMany();await db.client.staffUser.deleteMany();
 staff=await db.client.staffUser.create({data:{displayName:'Synthetic Owner',normalizedEmail:'ops-owner@example.test',passwordHash:'synthetic-not-login-hash'}});clock=(await db.client.$queryRaw`SELECT clock_timestamp() AS now`)[0].now;
});
after(async()=>{await db.client.$executeRawUnsafe('TRUNCATE TABLE quotation CASCADE');await db.close();});
const session=async(data={},owner=staff)=>db.client.staffSession.create({data:{staffId:owner.id,tokenHash:randomBytes(32),recoveryEpoch:epoch,createdAt:new Date(clock-9*3600000),lastSeenAt:new Date(clock-600000),absoluteExpiresAt:new Date(clock.getTime()+3600000),...data}});
const grant=async({expired=false,revoked=false}={})=>{
 const q=await db.client.quotation.create({data:{ownerId:staff.id}}),v=await db.client.quotationVersion.create({data:{quotationId:q.id,number:1,state:'SHARED',sharedAt:clock,content:{currency:'VND',companySnapshot:{displayName:'Synthetic'},lines:[],customer:{name:'Synthetic'},work:{description:'Synthetic'},calculation:{complete:false,subtotal:'0',total:null},terms:null}}});await db.client.quotation.update({where:{id:q.id},data:{latestSharedVersionId:v.id}});
 const generation=key(),issuedAt=new Date(clock-(expired?721:1)*3600000),encrypted=new ViewingTokens(old).issue(q.id,v.id,generation),row=await db.client.viewingAccess.create({data:{quotationId:q.id,versionId:v.id,generation,...encrypted,issuedAt,expiresAt:new Date(issuedAt.getTime()+720*3600000)}});
 if(revoked)return db.client.viewingAccess.update({where:{quotationId:q.id},data:{revokedAt:clock,tokenCiphertext:null,tokenNonce:null,tokenTag:null,encryptionKeyId:null}});return row;
};
test('housekeeping only removes unusable sessions and expired buckets/ciphertext, never snapshots receipts or live access',async()=>{
 const live=await session(),expired=await session({lastSeenAt:new Date(clock-600000),absoluteExpiresAt:new Date(clock-1000)}),idle=await session({lastSeenAt:new Date(clock-31*60000)}),revoked=await session({revokedAt:clock}),oldEpoch=await session({recoveryEpoch:key()}),a=await grant(),dead=await grant({expired:true});
 await db.client.rateLimitBucket.createMany({data:[{scope:'test',keyDigest:randomBytes(32),windowStart:new Date(clock-60000),count:1,expiresAt:new Date(clock-1)},{scope:'test',keyDigest:randomBytes(32),windowStart:clock,count:1,expiresAt:new Date(clock.getTime()+60000)}]});
 const intent=key();await db.client.operationReceipt.create({data:{actorId:staff.id,idempotencyKey:intent,fingerprint:randomBytes(32),fingerprintKeyId:'v1',recoveryEpoch:epoch,kind:'SYNTHETIC',method:'POST',route:'/synthetic',target:{quotationId:a.quotationId},resourceIds:{quotationId:a.quotationId},appliedRevisions:{quotation:1},committedAt:clock}});
 const snapshots=await db.client.quotationVersion.findMany(),result=await service.housekeeping(100);assert.equal(result.sessionsDeleted,4);assert.equal(result.rateBucketsDeleted,1);assert.equal(result.expiredCiphertextsCleared,1);
 assert.ok(await db.client.staffSession.findUnique({where:{id:live.id}}));for(const row of [expired,idle,revoked,oldEpoch])assert.equal(await db.client.staffSession.findUnique({where:{id:row.id}}),null);
 assert.deepEqual(await db.client.viewingAccess.findUnique({where:{quotationId:a.quotationId}}),a);const cleaned=await db.client.viewingAccess.findUnique({where:{quotationId:dead.quotationId}});assert.equal(cleaned.tokenCiphertext,null);assert.equal(cleaned.revokedAt,null);assert.equal(cleaned.revision,dead.revision);assert.equal(cleaned.expiresAt.toISOString(),dead.expiresAt.toISOString());assert.deepEqual(await db.client.quotationVersion.findMany(),snapshots);assert.equal(await db.client.operationReceipt.count(),1);
});
test('maintenance bounds batches and skips contended staff or quotation rows for later work',async()=>{
 const {default:pg}=await import('pg'),control=new pg.Client({connectionString:testUrl});await control.connect();const a=await grant({expired:true});await session({revokedAt:clock});
 try{await control.query('BEGIN');await control.query('SELECT id FROM staff_user WHERE id=$1 FOR UPDATE',[staff.id]);await control.query('SELECT id FROM quotation WHERE id=$1 FOR UPDATE',[a.quotationId]);const r=await service.housekeeping(1);assert.equal(r.sessionsDeleted,0);assert.equal(r.expiredCiphertextsCleared,0);await control.query('COMMIT');assert.equal((await service.housekeeping(1)).sessionsDeleted,1);assert.equal((await db.client.viewingAccess.findUnique({where:{quotationId:a.quotationId}})).tokenCiphertext,null);}finally{await control.query('ROLLBACK');await control.end();}
 for(const limit of [0,-1,1001,1.5,NaN])await assert.rejects(()=>service.housekeeping(limit),e=>e.code==='INVALID_REQUEST');
});
test('viewing key rotation preserves raw token hash generation expiry ETags and immutable snapshots',async()=>{
 const a=await grant(),expired=await grant({expired:true}),revoked=await grant({revoked:true}),token=new ViewingTokens(old).recover(a),before=await db.client.quotationVersion.findMany(),quote=await db.client.quotation.findUnique({where:{id:a.quotationId}});
 const r=await service.reencryptViewing(1);assert.equal(r.reencrypted,1);const after=await db.client.viewingAccess.findUnique({where:{quotationId:a.quotationId}});assert.equal(after.encryptionKeyId,'v2');assert.notDeepEqual(after.tokenNonce,a.tokenNonce);assert.equal(new ViewingTokens(config).recover(after),token);
 for(const field of ['tokenHash','generation','issuedAt','expiresAt','revision','versionId','revokedAt'])assert.deepEqual(after[field],a[field]);assert.deepEqual(await db.client.quotationVersion.findMany(),before);assert.deepEqual(await db.client.quotation.findUnique({where:{id:a.quotationId}}),quote);assert.deepEqual(await db.client.viewingAccess.findUnique({where:{quotationId:expired.quotationId}}),expired);assert.deepEqual(await db.client.viewingAccess.findUnique({where:{quotationId:revoked.quotationId}}),revoked);assert.equal((await service.reencryptViewing(100)).reencrypted,0);
});
test('key audit retains historical receipt dependencies and missing keys fail closed on re-encryption',async()=>{
 const a=await grant(),intent=key();await db.client.operationReceipt.create({data:{actorId:staff.id,idempotencyKey:intent,fingerprint:randomBytes(32),fingerprintKeyId:'historic',recoveryEpoch:epoch,kind:'SYNTHETIC',method:'POST',route:'/synthetic',target:{},resourceIds:{},appliedRevisions:{},committedAt:clock}});
 const audit=await service.auditKeys();assert.deepEqual(audit.missingOperationKeyIds,['historic']);assert.deepEqual(audit.missingViewingKeyIds,[]);assert.equal(audit.safe,false);assert.equal(JSON.stringify(audit).includes(new ViewingTokens(old).recover(a)),false);
 const missing=new MaintenanceService({...config,viewingKeys:new Map([['v2',Buffer.alloc(32,8)]])},db);await assert.rejects(()=>missing.reencryptViewing(100),e=>e.code==='SERVICE_UNAVAILABLE');assert.deepEqual(await db.client.viewingAccess.findUnique({where:{quotationId:a.quotationId}}),a);assert.equal(await db.client.operationReceipt.count(),1);
});
test('planned CSRF session revocation is bounded and does not change accounts receipts epoch or access',async()=>{
 const one=await session(),two=await session(),a=await grant(),before=await db.client.staffUser.findUnique({where:{id:staff.id}});assert.equal((await service.revokeSessions(1)).sessionsRevoked,1);assert.equal((await service.revokeSessions(1)).sessionsRevoked,1);assert.equal((await service.revokeSessions(1)).sessionsRevoked,0);
 for(const s of [one,two]){const changed=await db.client.staffSession.findUnique({where:{id:s.id}});assert.ok(changed.revokedAt);assert.equal(changed.recoveryEpoch,epoch);}assert.deepEqual(await db.client.staffUser.findUnique({where:{id:staff.id}}),before);assert.deepEqual(await db.client.viewingAccess.findUnique({where:{quotationId:a.quotationId}}),a);
});
test('maintenance CLI accepts bounded commands, outputs only safe counts and rejects arguments without secrets',async()=>{
 const values={...process.env,DATABASE_URL:testUrl,ADMIN_ORIGIN:config.adminOrigin,USER_ORIGIN:config.userOrigin,RECOVERY_EPOCH:epoch,CSRF_HMAC_KEY:config.csrfKey.toString('base64'),RATE_LIMIT_HMAC_KEY:config.rateLimitKey.toString('base64'),REVIEW_HMAC_KEY:config.reviewKey.toString('base64'),OPERATION_HMAC_KEYS:JSON.stringify(Object.fromEntries([...config.operationKeys].map(([id,value])=>[id,value.toString('base64')]))),OPERATION_HMAC_CURRENT_KEY_ID:config.operationKeyId,VIEWING_LINK_KEYS:JSON.stringify(Object.fromEntries([...config.viewingKeys].map(([id,value])=>[id,value.toString('base64')]))),VIEWING_LINK_CURRENT_KEY_ID:config.viewingKeyId};
 for(const args of [['housekeeping','--batch-size','1'],['keys','audit'],['keys','reencrypt-viewing','--batch-size','1'],['keys','revoke-sessions','--batch-size','1']]){const r=spawnSync(process.execPath,['dist/operations/operator.js',...args],{env:values,encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);assert.doesNotThrow(()=>JSON.parse(r.stdout));assert.equal(r.stdout.includes(config.csrfKey.toString('base64')),false);}
 const bad=spawnSync(process.execPath,['dist/operations/operator.js','keys','reencrypt-viewing','--key','secret-example'],{env:values,encoding:'utf8',timeout:15000});assert.equal(bad.status,1);assert.equal((bad.stdout+bad.stderr).includes('secret-example'),false);
});

test('real readiness is read-only and rejects incompatible schema guards content or missing historical keys',async()=>{
 const {default:pg}=await import('pg'),control=new pg.Client({connectionString:testUrl});await control.connect();
 const ready=()=>db.checkReadiness(config).catch(()=>false),a=await grant();
 const sessions=await session(),before=await db.client.staffSession.findUnique({where:{id:sessions.id}}),snapshots=await db.client.quotationVersion.findMany();
 assert.equal(await ready(),true);assert.deepEqual(await db.client.staffSession.findUnique({where:{id:sessions.id}}),before);assert.deepEqual(await db.client.viewingAccess.findUnique({where:{quotationId:a.quotationId}}),a);assert.equal(await db.client.operationReceipt.count(),0);
 try{
  await control.query('ALTER TABLE quotation_version DISABLE TRIGGER quotation_version_immutable_guard');assert.equal(await ready(),false);
  await control.query('ALTER TABLE quotation_version ENABLE TRIGGER quotation_version_immutable_guard');
  await control.query('ALTER INDEX quotation_version_one_draft_idx RENAME TO synthetic_hidden_draft_index');assert.equal(await ready(),false);await control.query('ALTER INDEX synthetic_hidden_draft_index RENAME TO quotation_version_one_draft_idx');
  await control.query('ALTER TABLE company_profile RENAME COLUMN display_name TO synthetic_hidden_name');assert.equal(await ready(),false);await control.query('ALTER TABLE company_profile RENAME COLUMN synthetic_hidden_name TO display_name');
 }finally{
  await control.query('ALTER TABLE quotation_version ENABLE TRIGGER quotation_version_immutable_guard');
  const index=await control.query("SELECT to_regclass('public.synthetic_hidden_draft_index') AS id");if(index.rows[0].id)await control.query('ALTER INDEX synthetic_hidden_draft_index RENAME TO quotation_version_one_draft_idx');
  const renamed=await control.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='company_profile' AND column_name='synthetic_hidden_name'");if(renamed.rowCount)await control.query('ALTER TABLE company_profile RENAME COLUMN synthetic_hidden_name TO display_name');await control.end();
 }
 assert.equal(await ready(),true);assert.deepEqual(await db.client.quotationVersion.findMany(),snapshots);
 const draft=await db.client.quotation.create({data:{ownerId:staff.id}}),unsupported=await db.client.quotationVersion.create({data:{quotationId:draft.id,number:1,schemaVersion:2,content:{}}});assert.equal(await ready(),false);await db.client.quotationVersion.delete({where:{id:unsupported.id}});
 assert.equal(await db.checkReadiness({...config,viewingKeys:new Map([['v2',Buffer.alloc(32,8)]])}),false);
 await db.client.operationReceipt.create({data:{actorId:staff.id,idempotencyKey:key(),fingerprint:randomBytes(32),fingerprintKeyId:'historic',recoveryEpoch:epoch,kind:'SYNTHETIC',method:'POST',route:'/synthetic',target:{},resourceIds:{},appliedRevisions:{},committedAt:clock}});assert.equal(await ready(),false);
 assert.equal(await db.checkReadiness({...config,operationKeys:new Map([...config.operationKeys,['historic',Buffer.alloc(32,9)]])}),true);
});
test('maintenance rechecks a grant replaced between candidate scan and quotation lock instead of clearing its new material',async()=>{
 const a=await grant({expired:true}),original=db.client.viewingAccess.findMany.bind(db.client.viewingAccess);let replaced;
 db.client.viewingAccess.findMany=async function(...args){const candidates=await original(...args);if(!replaced&&candidates.length){const generation=key(),issuedAt=new Date(),encrypted=new ViewingTokens(config).issue(a.quotationId,a.versionId,generation);replaced=await db.client.viewingAccess.update({where:{quotationId:a.quotationId},data:{generation,...encrypted,issuedAt,expiresAt:new Date(issuedAt.getTime()+720*3600000),revision:{increment:1}}});}return candidates;};
 try{assert.equal((await service.housekeeping(1)).expiredCiphertextsCleared,0);}finally{db.client.viewingAccess.findMany=original;}
 assert.deepEqual(await db.client.viewingAccess.findUnique({where:{quotationId:a.quotationId}}),replaced);
});
test('housekeeping rechecks a refreshed session after its initial idle-expiry candidate scan',async()=>{
 const row=await session({lastSeenAt:new Date(clock-31*60000)}),original=db.client.$queryRaw.bind(db.client);let refreshed=false;
 db.client.$queryRaw=async function(...args){const result=await original(...args);if(!refreshed&&Array.isArray(args[0])&&args[0].join('').includes('FROM staff_session s JOIN staff_user')){refreshed=true;await db.client.staffSession.update({where:{id:row.id},data:{lastSeenAt:new Date()}});}return result;};
 try{const r=await service.housekeeping(1);assert.equal(r.scannedSessions,1);assert.equal(r.sessionsDeleted,0);}finally{db.client.$queryRaw=original;}
 assert.equal(refreshed,true);assert.ok(await db.client.staffSession.findUnique({where:{id:row.id}}));
});
