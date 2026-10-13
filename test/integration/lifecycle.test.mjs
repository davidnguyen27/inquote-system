import assert from 'node:assert/strict';
import test,{before,after,beforeEach} from 'node:test';
import request from 'supertest';
import { Database } from '../../dist/database/prisma.js';
import { createApp } from '../../dist/app.js';
import { PasswordService } from '../../dist/modules/auth/password.service.js';
import { AdministratorProvisioningService } from '../../dist/modules/auth/provisioning.service.js';
import { AuthRepository } from '../../dist/modules/auth/auth.repository.js';
import { AuthService } from '../../dist/modules/auth/auth.service.js';
import { SessionService, staffETag } from '../../dist/modules/auth/security.js';
import { OperationReceiptService } from '../../dist/modules/auth/operation-receipt.service.js';
import {fixtureConfig,testUrl,origin,password,nextPassword,epoch,key} from '../helpers.mjs';
if(!testUrl||!new URL(testUrl).pathname.endsWith('_test'))throw new Error('A dedicated TEST_DATABASE_URL ending in _test is required.');
const db=new Database(testUrl),second=new Database(testUrl),pwd=new PasswordService(),config=fixtureConfig();
const security=new SessionService(config.csrfKey),repo=new AuthRepository(db,security,epoch),app=createApp(config,db);
let hash,user;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
before(async()=>hash=await pwd.hash(password));
after(async()=>{await db.close();await second.close();});
beforeEach(async()=>{await db.client.operationReceipt.deleteMany();await db.client.staffSession.deleteMany();await db.client.rateLimitBucket.deleteMany();await db.client.staffUser.deleteMany();user=await db.client.staffUser.create({data:{displayName:'Synthetic staff',normalizedEmail:'staff@example.test',passwordHash:hash}});});
const login=()=>request(app).post('/api/v1/auth/login').set('Origin',origin).send({email:'staff@example.test',password});
const token=r=>r.headers['set-cookie'][0].split(';')[0].split('=')[1];
test('concurrent administrator bootstrap is serialized and reset revokes sessions',async()=>{
  const service=new AdministratorProvisioningService(db,pwd),other=new AdministratorProvisioningService(second,pwd);
  const results=await Promise.allSettled([service.bootstrap('admin@example.test','Synthetic Admin',password),other.bootstrap('other@example.test','Other Admin',password)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(await db.client.staffUser.count({where:{role:'ADMINISTRATOR'}}),1);
  const admin=await db.client.staffUser.findFirst({where:{role:'ADMINISTRATOR'}});
  const now=new Date();await db.client.staffSession.create({data:{staffId:admin.id,tokenHash:new Uint8Array(32),recoveryEpoch:epoch,createdAt:now,lastSeenAt:now,absoluteExpiresAt:new Date(now.getTime()+3600000)}});
  await service.reset(admin.normalizedEmail,nextPassword);
  assert.ok((await db.client.staffSession.findFirst()).revokedAt);
  assert.equal(await pwd.verify((await db.client.staffUser.findUnique({where:{id:admin.id}})).passwordHash,nextPassword),true);
  await assert.rejects(()=>service.reset(user.normalizedEmail,nextPassword),e=>e.code==='NOT_FOUND');
});
test('authorization holds staff/session locks through materialization before disable commits',async()=>{
  const s=await login(),entered=deferred(),release=deferred();let disabled=false;
  const read=repo.withSession(token(s),{allowLimited:false},async context=>{entered.resolve();await release.promise;return context.staff.enabled;});
  await entered.promise;
  const disable=second.transaction(async tx=>{await tx.$queryRaw`SELECT id FROM staff_user WHERE id=${user.id}::uuid FOR UPDATE`;await tx.staffUser.update({where:{id:user.id},data:{enabled:false,revision:{increment:1}}});disabled=true;});
  await new Promise(r=>setTimeout(r,50));assert.equal(disabled,false);
  release.resolve();assert.equal(await read,true);await disable;
  await assert.rejects(()=>repo.withSession(token(s),{allowLimited:false},async()=>true),e=>e.code==='SESSION_REQUIRED');
});
test('login rechecks credential revision after outside-transaction verification',async()=>{
  const entered=deferred(),release=deferred();
  const controlled={verify:async(h,p)=>{const result=await pwd.verify(h,p);entered.resolve();await release.promise;return result;},dummyVerify:p=>pwd.dummyVerify(p)};
  const service=new AuthService(config,repo,controlled,security,new OperationReceiptService(config));
  const pending=service.login({email:'staff@example.test',password});await entered.promise;
  await second.transaction(async tx=>{await tx.$queryRaw`SELECT id FROM staff_user WHERE id=${user.id}::uuid FOR UPDATE`;await tx.staffUser.update({where:{id:user.id},data:{passwordHash:await pwd.hash(nextPassword),revision:{increment:1}}});});
  release.resolve();await assert.rejects(()=>pending,e=>e.code==='INVALID_CREDENTIALS');assert.equal(await db.client.staffSession.count(),0);
});
test('clock sampling after a blocked staff lock prevents extending expired sessions',async()=>{
  const s=await login(),started=deferred(),release=deferred();
  const held=second.transaction(async tx=>{await tx.$queryRaw`SELECT id FROM staff_user WHERE id=${user.id}::uuid FOR UPDATE`;started.resolve();await release.promise;
    await tx.staffSession.updateMany({where:{staffId:user.id},data:{createdAt:new Date(Date.now()-3600000),lastSeenAt:new Date(Date.now()-31*60000)}});
  });
  await started.promise;const pending=repo.withSession(token(s),{allowLimited:false},async()=>true);
  await new Promise(r=>setTimeout(r,50));release.resolve();await held;
  await assert.rejects(()=>pending,e=>e.code==='SESSION_REQUIRED');
});
test('controlled exact idle and absolute boundaries reject sessions',async()=>{
  const s=await login(),row=await db.client.staffSession.findFirst();const original=repo.clock.bind(repo);
  try{
    repo.clock=async()=>new Date(row.lastSeenAt.getTime()+30*60000);
    await assert.rejects(()=>repo.withSession(token(s),{allowLimited:false},async()=>true),e=>e.code==='SESSION_REQUIRED');
    repo.clock=async()=>row.absoluteExpiresAt;
    await assert.rejects(()=>repo.withSession(token(s),{allowLimited:false},async()=>true),e=>e.code==='SESSION_REQUIRED');
  }finally{repo.clock=original;}
});
test('receipt failure rolls password and revocations back; actor and epoch scope protect receipt lookup',async()=>{
  const s=await login(),originalReceipts=new OperationReceiptService(config);
  const receipts=Object.assign(originalReceipts,{create:async()=>{throw new Error('synthetic storage failure');}});
  const service=new AuthService(config,repo,pwd,security,receipts);
  await assert.rejects(()=>service.changePassword(token(s),s.body.csrfToken,{currentPassword:password,newPassword:nextPassword},{epoch,key:key(),precondition:s.body.staffETag}));
  assert.equal(await db.client.operationReceipt.count(),0);assert.equal((await db.client.staffSession.findFirst()).revokedAt,null);
  assert.equal(await pwd.verify((await db.client.staffUser.findUnique({where:{id:user.id}})).passwordHash,password),true);
  const other=await db.client.staffUser.create({data:{displayName:'Other',normalizedEmail:'other@example.test',passwordHash:hash}});
  const operationKey=key();await db.client.operationReceipt.create({data:{actorId:other.id,idempotencyKey:operationKey,fingerprint:new Uint8Array(32),fingerprintKeyId:'v1',recoveryEpoch:epoch,kind:'CHANGE_PASSWORD',method:'POST',route:'/api/v1/auth/change-password',target:{staffId:other.id},resourceIds:{staffId:other.id},appliedRevisions:{staff:2},committedAt:new Date()}});
  const normal=new AuthService(config,repo,pwd,security,new OperationReceiptService(config));
  await assert.rejects(()=>normal.operation(token(s),operationKey,epoch),e=>e.code==='OPERATION_UNKNOWN');
  await assert.rejects(()=>normal.operation(token(s),operationKey,'different-epoch'),e=>e.code==='RECOVERY_REQUIRED');
});
test('staff request rate limit is bounded by its own session and ignores spoofed forwarding headers',async()=>{
  const s=await login();const digest=Buffer.from(security.digest(token(s))).toString('hex');
  const {createHmac}=await import('node:crypto');
  const keyDigest=new Uint8Array(createHmac('sha256',config.rateLimitKey).update(JSON.stringify(['staff_session',digest])).digest());
  const rows=await db.client.$queryRaw`SELECT clock_timestamp() AS now`;
  const start=new Date(Math.floor(rows[0].now.getTime()/60000)*60000);
  await db.client.rateLimitBucket.create({data:{scope:'staff_session',keyDigest,windowStart:start,count:300,expiresAt:new Date(start.getTime()+60000)}});
  const r=await request(app).get('/api/v1/auth/session').set('Cookie','__Host-inquote_session='+token(s)).set('X-Forwarded-For','198.51.100.1');
  assert.equal(r.status,429);assert.ok(Number(r.headers['retry-after'])>0);
});

test('temporary expiry clamps absolute expiry and limited sessions cannot read business receipts',async()=>{
  const clocks=await db.client.$queryRaw`SELECT clock_timestamp() AS now`;
  assert.ok(Math.abs(clocks[0].now.getTime()-Date.now())<5000,'Adapter must preserve the UTC instant on a non-UTC PostgreSQL server');
  const expires=new Date(Date.now()+60000);
  await db.client.staffUser.update({where:{id:user.id},data:{mustChangePassword:true,temporaryCredentialExpiresAt:expires}});
  const s=await login();assert.equal(s.status,200);assert.equal(s.body.absoluteExpiresAt,expires.toISOString());
  const operationKey=key();await db.client.operationReceipt.create({data:{actorId:user.id,idempotencyKey:operationKey,fingerprint:new Uint8Array(32),fingerprintKeyId:'v1',recoveryEpoch:epoch,kind:'SAVE_DRAFT',method:'POST',route:'/api/v1/quotations',target:{},resourceIds:{},appliedRevisions:{},committedAt:new Date()}});
  const service=new AuthService(config,repo,pwd,security,new OperationReceiptService(config));
  await assert.rejects(()=>service.operation(token(s),operationKey,epoch),e=>e.code==='OPERATION_UNKNOWN');
  const original=repo.clock;try{repo.clock=async()=>expires;await assert.rejects(()=>repo.withSession(token(s),{allowLimited:true},async()=>true),e=>e.code==='SESSION_REQUIRED');}finally{repo.clock=original;}
});

test('concurrent password changes serialize one commit and never leave a live old session',async()=>{
  const a=await login(),b=await login(),operationKey=key();
  const change=s=>request(app).post('/api/v1/auth/change-password').set('Origin',origin).set('Cookie','__Host-inquote_session='+token(s)).set('X-CSRF-Token',s.body.csrfToken).set('If-Match',s.body.staffETag).set('Idempotency-Key',operationKey).set('X-Recovery-Epoch',epoch).send({currentPassword:password,newPassword:nextPassword});
  const results=await Promise.all([change(a),change(b)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,401]);assert.equal(await db.client.operationReceipt.count(),1);
  assert.equal(await db.client.staffSession.count({where:{revokedAt:null}}),0);assert.equal((await db.client.staffUser.findUnique({where:{id:user.id}})).revision,2);
});

test('fingerprint key rotation replays original intent and missing historical keys fail closed',async()=>{
  const s=await login(),operationKey=key(),body={currentPassword:password,newPassword:nextPassword},headers={epoch,key:operationKey,precondition:s.body.staffETag};
  await new AuthService(config,repo,pwd,security,new OperationReceiptService(config)).changePassword(token(s),s.body.csrfToken,body,headers);
  const fresh=await request(app).post('/api/v1/auth/login').set('Origin',origin).send({email:user.normalizedEmail,password:nextPassword});
  const rotated={...config,operationKeyId:'v2',operationKeys:new Map([...config.operationKeys,['v2',Buffer.alloc(32,6)]])};
  const service=new AuthService(rotated,repo,pwd,security,new OperationReceiptService(rotated));
  assert.equal((await service.changePassword(token(fresh),fresh.body.csrfToken,body,headers)).replayed,true);
  const missing={...rotated,operationKeys:new Map([['v2',Buffer.alloc(32,6)]])};
  await assert.rejects(()=>new AuthService(missing,repo,pwd,security,new OperationReceiptService(missing)).changePassword(token(fresh),fresh.body.csrfToken,body,headers),e=>e.code==='SERVICE_UNAVAILABLE');
  assert.equal((await db.client.staffSession.findUnique({where:{tokenHash:security.digest(token(fresh))}})).revokedAt,null);
});

test('real PostgreSQL transaction conflicts retry at most three times',async()=>{
  let attempts=0;
  const result=await db.transaction(async tx=>{attempts++;if(attempts===1)await tx.$executeRawUnsafe("DO $$ BEGIN RAISE EXCEPTION 'synthetic conflict' USING ERRCODE='40001'; END $$");return 'committed';});
  assert.equal(result,'committed');assert.equal(attempts,2);attempts=0;
  await assert.rejects(()=>db.transaction(async tx=>{attempts++;await tx.$executeRawUnsafe("DO $$ BEGIN RAISE EXCEPTION 'synthetic conflict' USING ERRCODE='40P01'; END $$");}),e=>e.code==='SERVICE_UNAVAILABLE');
  assert.equal(attempts,3);
});

test('operator accepts protected stdin, rejects password arguments and never returns secrets',async()=>{
  const {spawn}=await import('node:child_process');
  const run=(args,input)=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['dist/modules/auth/operator.js',...args],{env:{...process.env,DATABASE_URL:testUrl},windowsHide:true,stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);child.on('error',reject);child.on('close',code=>resolve({code,output}));child.stdin.end(input);});
  const first=await run(['bootstrap','--email','operator@example.test','--display-name','Synthetic Operator'],password+'\n');
  assert.equal(first.code,0,first.output);assert.equal(first.output.includes(password),false);
  const reset=await run(['reset','--email','operator@example.test'],nextPassword+'\n');assert.equal(reset.code,0,reset.output);assert.equal(reset.output.includes(nextPassword),false);
  const unsafe=await run(['reset','--email','operator@example.test','--password',password],'');assert.equal(unsafe.code,1);assert.equal(unsafe.output.includes(password),false);
  const invalid=await run(['reset','--email','not an email'],nextPassword+'\n');assert.equal(invalid.code,1);assert.ok(invalid.output.includes('INVALID_REQUEST'));assert.equal(invalid.output.includes(nextPassword),false);
  assert.equal(await pwd.verify((await db.client.staffUser.findUnique({where:{normalizedEmail:'operator@example.test'}})).passwordHash,nextPassword),true);
});

test('Administrator provisioning rejects malformed email encoding before any database change',async()=>{
 const {AdministratorProvisioningService}=await import('../../dist/modules/auth/provisioning.service.js');const service=new AdministratorProvisioningService(db,pwd);
 const before=await db.client.staffUser.findMany({orderBy:{id:'asc'}}),sessions=await db.client.staffSession.count(),receipts=await db.client.operationReceipt.count();
 for(const email of ['a\ud800b@example.test','a@\udfff.test','a\u0000b@example.test','a@\u0000.test']){
  for(const call of [()=>service.bootstrap(email,'Synthetic Administrator',password),()=>service.reset(email,nextPassword)])await assert.rejects(call,e=>e.status===400&&e.code==='INVALID_REQUEST');
 }
 assert.deepEqual(await db.client.staffUser.findMany({orderBy:{id:'asc'}}),before);assert.equal(await db.client.staffSession.count(),sessions);assert.equal(await db.client.operationReceipt.count(),receipts);
 const id=await service.bootstrap(' A.User+Tag@😀.COM ',' 😀\nAdministrator ',password),row=await db.client.staffUser.findUnique({where:{id}});assert.equal(row.normalizedEmail,'a.user+tag@😀.com');assert.equal(row.displayName,'😀\nAdministrator');
});
