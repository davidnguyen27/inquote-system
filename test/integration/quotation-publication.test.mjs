import assert from 'node:assert/strict';
import test,{before,beforeEach,after} from 'node:test';
import request from 'supertest';
import {Database} from '../../dist/database/prisma.js';
import {createApp} from '../../dist/app.js';
import {PasswordService} from '../../dist/modules/auth/password.service.js';
import {AuthRepository} from '../../dist/modules/auth/auth.repository.js';
import {PublicationService} from '../../dist/modules/quotations/publication.service.js';
import {fixtureConfig,testUrl,origin,password,epoch,key} from '../helpers.mjs';
if(!testUrl||!new URL(testUrl).pathname.endsWith('_test'))throw Error('Dedicated TEST_DATABASE_URL ending _test required');
const db=new Database(testUrl),config=fixtureConfig(),app=createApp(config,db);
let hash,employee,admin,other,session,adminSession,otherSession;
const cookie=r=>r.headers['set-cookie'][0].split(';')[0];
const login=(email,target=app)=>request(target).post('/api/v1/auth/login').set('Origin',origin).send({email,password});
const get=(path,actor=session,target=app)=>request(target).get('/api/v1'+path).set('Cookie',cookie(actor));
const post=(path,body,{actor=session,etag,operationKey=key(),target=app,recoveryEpoch=epoch}={})=>{
 const req=request(target).post('/api/v1'+path).set('Cookie',cookie(actor)).set('Origin',origin).set('X-CSRF-Token',actor.body.csrfToken).set('Idempotency-Key',operationKey).set('X-Recovery-Epoch',recoveryEpoch);if(etag)req.set('If-Match',etag);return req.send(body);
};
const read=async q=>(await get(q.path)).body;
const access=async q=>(await get(q.path+'/access')).body;
const review=async q=>{const r=await post(q.path+'/share-review',{}, {etag:(await read(q)).etag});assert.equal(r.status,200,JSON.stringify(r.body));return r;};
const share=async(q,options={})=>{const r=await review(q);return post(q.path+'/share',{reviewToken:r.body.reviewToken},{etag:r.body.draftETag,...options});};
const link=async q=>{const a=await access(q);const r=await get(q.path+'/access/link').set('If-Match',a.etag);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
const view=(token,target=app)=>request(target).post('/api/v1/public/quotation-view').send({token});
const empty=()=>({customer:{name:'Customer',contactPerson:'Private Person',phone:'PRIVATE-PHONE',email:'private@example.test',address:'Private address'},work:{description:'Kitchen works',siteAddress:'Work site'},terms:'<b>Plain text only</b>',lines:[]});
const create=async(complete=true)=>{
 const r=await post('/quotations',{});assert.equal(r.status,201);const {quotationId:q,versionId:v}=r.body.operation.resourceIds,quote={q,v,path:`/quotations/${q}/versions/${v}`};
 if(complete){const body={...empty(),lines:[{lineId:key(),kind:'CUSTOM',description:'Task',unit:'job',quantity:'0.5',unitPrice:'101'},{lineId:key(),kind:'CUSTOM',description:'Task 2',unit:'job',quantity:'0.5',unitPrice:'101'}]};const save=await request(app).put('/api/v1'+quote.path+'/draft').set('Cookie',cookie(session)).set('Origin',origin).set('X-CSRF-Token',session.body.csrfToken).set('Idempotency-Key',key()).set('X-Recovery-Epoch',epoch).set('If-Match',(await read(quote)).etag).send(body);assert.equal(save.status,200);}
 return quote;
};
before(async()=>hash=await new PasswordService().hash(password));
beforeEach(async()=>{
 await db.client.$executeRawUnsafe('TRUNCATE TABLE quotation CASCADE');await db.client.operationReceipt.deleteMany();await db.client.staffSession.deleteMany();await db.client.rateLimitBucket.deleteMany();await db.client.staffUser.deleteMany();await db.client.catalogItem.deleteMany();await db.client.companyProfile.update({where:{id:1},data:{displayName:'Original Company',address:'Company address',phone:null,email:null,revision:1}});
 employee=await db.client.staffUser.create({data:{displayName:'Owner',normalizedEmail:'owner@example.test',passwordHash:hash}});admin=await db.client.staffUser.create({data:{displayName:'Admin',normalizedEmail:'admin@example.test',role:'ADMINISTRATOR',passwordHash:hash}});other=await db.client.staffUser.create({data:{displayName:'Other',normalizedEmail:'other@example.test',passwordHash:hash}});session=await login(employee.normalizedEmail);adminSession=await login(admin.normalizedEmail);otherSession=await login(other.normalizedEmail);
});
after(async()=>{await db.client.$executeRawUnsafe('TRUNCATE TABLE quotation CASCADE');await db.close();});

test('revision returns an existing draft before a stale allocation tag and preserves ownership',async()=>{
 const q=await create(false),r=await post(`/quotations/${q.q}/revisions`,{},{etag:'"old"',actor:adminSession});assert.equal(r.status,200);assert.equal(r.body.operation.resourceIds.versionId,q.v);assert.equal((await get(`/quotations/${q.q}`,adminSession)).body.ownerId,employee.id);assert.equal(await db.client.quotationVersion.count(),1);
});
test('saved review is read-only, allowlisted, complete and uses server calculations',async()=>{
 const q=await create(),before=await read(q),receipts=await db.client.operationReceipt.count(),r=await review(q);assert.equal(r.body.presentation.total,'102');assert.equal(r.body.presentation.sharedAt,null);assert.deepEqual(r.body.presentation.customer,{name:'Customer'});assert.equal(r.body.presentation.terms,'<b>Plain text only</b>');assert.equal((await read(q)).etag,before.etag);assert.equal(await db.client.operationReceipt.count(),receipts);assert.equal((await review(q)).body.draftETag,before.etag);
 const incomplete=await create(false);assert.equal((await post(incomplete.path+'/share-review',{},{etag:(await read(incomplete)).etag})).status,422);
});
test('share freezes content and company, emits only a receipt and exposes an anonymous allowlisted snapshot',async()=>{
 const q=await create(),r=await share(q);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.operation.kind,'SHARE_QUOTATION');assert.ok(r.body.operation.accessGeneration);assert.equal('url' in r.body,false);const saved=await read(q);assert.equal(saved.state,'SHARED');assert.equal('companyContext' in saved,false);
 await db.client.companyProfile.update({where:{id:1},data:{displayName:'Changed Company',revision:2}});const l=await link(q);assert.match(l.url,/^https:\/\/quote\.example\.test\/q#[A-Za-z0-9_-]{43}$/);const p=await view(new URL(l.url).hash.slice(1));assert.equal(p.status,200);assert.equal(p.body.total,'102');assert.equal(p.body.company.displayName,'Original Company');assert.deepEqual(p.body.customer,{name:'Customer'});assert.deepEqual(Object.keys(p.body).sort(),['company','currency','customer','lines','reference','sharedAt','terms','total','versionNumber','work']);assert.deepEqual(Object.keys(p.body.lines[0]).sort(),['amount','description','quantity','unit','unitPrice']);assert.equal(p.headers['cache-control'],'no-store');assert.equal(p.headers['referrer-policy'],'no-referrer');assert.equal(JSON.stringify(p.body).includes('PRIVATE'),false);
 const stored=await db.client.viewingAccess.findUnique({where:{quotationId:q.q}});assert.equal(stored.tokenHash.length,32);assert.equal(stored.tokenNonce.length,12);assert.equal(stored.tokenTag.length,16);assert.equal(stored.expiresAt-stored.issuedAt,720*3600000);assert.equal(Buffer.from(stored.tokenCiphertext).includes(Buffer.from(new URL(l.url).hash.slice(1))),false);
});
test('successor draft preserves access; share supersedes old tokens and version gaps are never reused',async()=>{
 const q=await create();assert.equal((await share(q)).status,200);const old=await link(q),first=await read(q),summary=(await get(`/quotations/${q.q}`)).body;
 const rev=await post(`/quotations/${q.q}/revisions`,{},{etag:summary.etag,actor:adminSession});assert.equal(rev.status,201);const v=rev.body.operation.resourceIds.versionId,next={q:q.q,v,path:`/quotations/${q.q}/versions/${v}`};assert.equal((await read(next)).number,2);assert.equal((await read(next)).ownerId,employee.id);assert.equal((await view(new URL(old.url).hash.slice(1))).status,200);
 const discarded=await request(app).delete('/api/v1'+next.path+'/draft').set('Cookie',cookie(session)).set('Origin',origin).set('X-CSRF-Token',session.body.csrfToken).set('Idempotency-Key',key()).set('X-Recovery-Epoch',epoch).set('If-Match',(await read(next)).etag);assert.equal(discarded.status,200);
 const third=await post(`/quotations/${q.q}/revisions`,{},{etag:(await get(`/quotations/${q.q}`)).body.etag});assert.equal(third.status,201);const successor={q:q.q,v:third.body.operation.resourceIds.versionId,path:`/quotations/${q.q}/versions/${third.body.operation.resourceIds.versionId}`};assert.equal((await read(successor)).number,3);assert.equal((await share(successor)).status,200);assert.equal((await view(new URL(old.url).hash.slice(1))).body.code,'LINK_UNAVAILABLE');assert.equal((await access(q)).status,'SUPERSEDED');assert.equal((await read(q)).sharedAt,first.sharedAt);assert.equal((await post(q.path+'/access/replace',{},{etag:'"old"'})).body.code,'ACCESS_SUPERSEDED');
});
test('copy, revoke, replace and exact replay do not change snapshots or extend previous generations',async()=>{
 const q=await create();assert.equal((await share(q)).status,200);const snapshot=await read(q),a=await access(q),l=await link(q);assert.deepEqual(await link(q),l);const operationKey=key(),r=await post(q.path+'/access/revoke',{},{etag:a.etag,operationKey});assert.equal(r.status,200);assert.equal((await view(new URL(l.url).hash.slice(1))).status,404);assert.equal((await access(q)).status,'REVOKED');assert.equal((await db.client.viewingAccess.findUnique({where:{quotationId:q.q}})).tokenCiphertext,null);assert.deepEqual((await post(q.path+'/access/revoke',{},{etag:a.etag,operationKey})).body,r.body);
 const replaceKey=key(),revoked=await access(q),replace=await post(q.path+'/access/replace',{},{etag:revoked.etag,operationKey:replaceKey});assert.equal(replace.status,200);const fresh=await link(q);assert.notEqual(fresh.url,l.url);assert.deepEqual((await post(q.path+'/access/replace',{},{etag:revoked.etag,operationKey:replaceKey})).body,replace.body);assert.deepEqual(await link(q),fresh);assert.equal((await view(new URL(fresh.url).hash.slice(1))).status,200);assert.equal((await read(q)).etag,snapshot.etag);assert.equal((await get('/operations/'+replaceKey).set('X-Recovery-Epoch',epoch)).body.accessGeneration,replace.body.operation.accessGeneration);
});
test('review bindings reject changed company, another actor and a tampered token without publication',async()=>{
 const q=await create(),r=await review(q),body={reviewToken:r.body.reviewToken};assert.equal((await post(q.path+'/share',body,{etag:r.body.draftETag,actor:adminSession})).body.code,'REVIEW_STALE');assert.equal((await post(q.path+'/share',{reviewToken:r.body.reviewToken+'x'},{etag:r.body.draftETag})).body.code,'REVIEW_STALE');await db.client.companyProfile.update({where:{id:1},data:{revision:2}});assert.equal((await post(q.path+'/share',body,{etag:r.body.draftETag})).body.code,'REVIEW_STALE');assert.equal((await read(q)).state,'DRAFT');assert.equal(await db.client.viewingAccess.count(),0);
});
test('public malformed tokens use uniform denial and never require or honor staff sessions',async()=>{
 for(const body of [{},{token:null},{token:[]},{token:'bad'},{token:'A'.repeat(43)},{token:'bad',extra:1}]){const r=await request(app).post('/api/v1/public/quotation-view').send(body);assert.equal(r.status,404);assert.equal(r.body.code,'LINK_UNAVAILABLE');assert.equal('errors' in r.body,false);}
 const q=await create();assert.equal((await share(q)).status,200);const token=new URL((await link(q)).url).hash.slice(1);const r=await request(app).post('/api/v1/public/quotation-view').set('Cookie','__Host-inquote_session=invalid').set('Origin','https://foreign.example.test').send({token});assert.equal(r.status,200);
});

test('a company edit invalidates review even when the edited profile is no longer share-ready',async()=>{
 const q=await create(),r=await review(q);await db.client.companyProfile.update({where:{id:1},data:{displayName:null,revision:2}});
 const response=await post(q.path+'/share',{reviewToken:r.body.reviewToken},{etag:r.body.draftETag});assert.equal(response.status,409);assert.equal(response.body.code,'REVIEW_STALE');
});
test('concurrent revisions reuse one allocated draft and concurrent identical shares publish one generation',async()=>{
 const q=await create(),r=await review(q),operationKey=key(),body={reviewToken:r.body.reviewToken},options={etag:r.body.draftETag,operationKey};
 const results=await Promise.all([post(q.path+'/share',body,options),post(q.path+'/share',body,options)]);assert.deepEqual(results.map(r=>r.status),[200,200]);assert.deepEqual(results[0].body,results[1].body);const original=await link(q),summary=(await get(`/quotations/${q.q}`)).body;
 const revisions=await Promise.all([post(`/quotations/${q.q}/revisions`,{},{etag:summary.etag}),post(`/quotations/${q.q}/revisions`,{},{etag:summary.etag,actor:adminSession})]);assert.deepEqual(revisions.map(r=>r.status).sort(),[200,201]);assert.equal(revisions[0].body.operation.resourceIds.versionId,revisions[1].body.operation.resourceIds.versionId);assert.equal(await db.client.quotationVersion.count(),2);assert.equal((await db.client.quotation.findUnique({where:{id:q.q}})).lastAllocatedNumber,2);assert.deepEqual(await link(q),original);
 assert.deepEqual((await post(q.path+'/share',body,options)).body,results[0].body);assert.deepEqual(await link(q),original);
});
test('competing actors with stale share and access tags cannot overwrite successful mutations',async()=>{
 const q=await create(),ownerReview=await review(q),tag=ownerReview.body.draftETag,administratorReview=await post(q.path+'/share-review',{},{actor:adminSession,etag:tag});
 const shares=await Promise.all([post(q.path+'/share',{reviewToken:ownerReview.body.reviewToken},{etag:tag}),post(q.path+'/share',{reviewToken:administratorReview.body.reviewToken},{etag:tag,actor:adminSession})]);assert.deepEqual(shares.map(r=>r.status).sort(),[200,412]);
 const a=await access(q),results=await Promise.all([post(q.path+'/access/replace',{},{etag:a.etag}),post(q.path+'/access/revoke',{},{etag:a.etag,actor:adminSession})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,412]);assert.equal((await read(q)).state,'SHARED');
});
test('receipt storage failure rolls back share, revision and access changes atomically',async()=>{
 const q=await create(),r=await review(q),before=await read(q),original= db.client.$transaction.bind(db.client);
 const fail=()=>{db.client.$transaction=(work,options)=>original(async tx=>{const proxy=new Proxy(tx,{get(target,name){if(name==='operationReceipt')return {...target.operationReceipt,create:async()=>{throw Error('synthetic receipt failure');}};return target[name];}});return work(proxy);},options);};
 try{fail();assert.equal((await post(q.path+'/share',{reviewToken:r.body.reviewToken},{etag:r.body.draftETag})).status,500);}finally{db.client.$transaction=original;}
 assert.equal((await read(q)).etag,before.etag);assert.equal(await db.client.viewingAccess.count(),0);assert.equal((await db.client.quotation.findUnique({where:{id:q.q}})).latestSharedVersionId,null);
 assert.equal((await share(q)).status,200);const a=await access(q),l=await link(q),summary=(await get(`/quotations/${q.q}`)).body;
 try{fail();assert.equal((await post(`/quotations/${q.q}/revisions`,{},{etag:summary.etag})).status,500);assert.equal((await post(q.path+'/access/replace',{},{etag:a.etag})).status,500);assert.equal((await post(q.path+'/access/revoke',{},{etag:a.etag})).status,500);}finally{db.client.$transaction=original;}
 assert.equal(await db.client.quotationVersion.count(),1);assert.equal((await db.client.quotation.findUnique({where:{id:q.q}})).lastAllocatedNumber,1);assert.deepEqual(await link(q),l);
});
test('expiry denies public and staff link retrieval, replacement restores access without changing snapshot',async()=>{
 const q=await create();assert.equal((await share(q)).status,200);const l=await link(q),token=new URL(l.url).hash.slice(1),now=(await db.client.$queryRaw`SELECT clock_timestamp() AS now`)[0].now;
 await db.client.viewingAccess.update({where:{quotationId:q.q},data:{issuedAt:new Date(now-720*3600000),expiresAt:now}});const a=await access(q);assert.equal(a.status,'EXPIRED');assert.equal((await view(token)).body.code,'LINK_UNAVAILABLE');assert.equal((await get(q.path+'/access/link').set('If-Match',a.etag)).body.code,'LINK_UNAVAILABLE');
 assert.equal((await post(q.path+'/access/replace',{},{etag:a.etag})).status,200);assert.equal((await view(new URL((await link(q)).url).hash.slice(1))).status,200);assert.equal((await view(token)).status,404);
});
test('new operations enforce strict bodies ownership setup CSRF epoch and scoped preconditions',async()=>{
 const q=await create(),r=await review(q),base={etag:r.body.draftETag};
 for(const path of ['/revisions','/versions/'+q.v+'/share-review','/versions/'+q.v+'/share','/versions/'+q.v+'/access/revoke','/versions/'+q.v+'/access/replace']){
  const body=path.endsWith('/share')?{reviewToken:r.body.reviewToken}:{};assert.equal((await post(`/quotations/${q.q}`+path,body,{...base,actor:otherSession})).status,404);
  assert.equal((await post(`/quotations/${q.q}`+path,{...body,ownerId:admin.id},base)).status,400);
 }
 for(const headers of [{recoveryEpoch:key()},{operationKey:'bad'},{etag:undefined},{etag:'*'},{etag:'W/'+r.body.draftETag}])assert.ok([400,409,428].includes((await post(q.path+'/share',{reviewToken:r.body.reviewToken},{...base,...headers})).status));
 const csrf=await request(app).post('/api/v1'+q.path+'/share').set('Cookie',cookie(session)).set('Origin',origin).set('If-Match',base.etag).set('X-Recovery-Epoch',epoch).set('Idempotency-Key',key()).send({reviewToken:r.body.reviewToken});assert.equal(csrf.status,403);
 assert.equal((await request(app).post('/api/v1'+q.path+'/share-review').set('Cookie',cookie(session)).set('Origin',origin).set('If-Match',base.etag).send({})).status,200);
 await db.client.staffUser.update({where:{id:employee.id},data:{mustChangePassword:true,temporaryCredentialExpiresAt:new Date(Date.now()+86400000)}});assert.equal((await post(q.path+'/share-review',{},base)).status,403);
});
test('fresh sessions and historic keys recover share receipts before expired review or later access state',async()=>{
 const q=await create(),r=await review(q),operationKey=key(),body={reviewToken:r.body.reviewToken},options={etag:r.body.draftETag,operationKey},shared=await post(q.path+'/share',body,options);assert.equal(shared.status,200);const original=await link(q),a=await access(q);assert.equal((await post(q.path+'/access/replace',{},{etag:a.etag})).status,200);const current=await link(q);
 const fresh=await login(employee.normalizedEmail),rotated=createApp({...config,operationKeyId:'v2',operationKeys:new Map([...config.operationKeys,['v2',Buffer.alloc(32,8)]])},db);
 const receipt=await get('/operations/'+operationKey,fresh,rotated).set('X-Recovery-Epoch',epoch);assert.equal(receipt.status,200);assert.equal(receipt.body.accessGeneration,original.generation);assert.deepEqual((await post(q.path+'/share',body,{...options,actor:fresh,target:rotated})).body,shared.body);assert.deepEqual(await link(q),current);
 const newEpoch=key(),restored=createApp({...config,recoveryEpoch:newEpoch},db),newLogin=await login(employee.normalizedEmail,restored);assert.equal((await post(q.path+'/share',body,{...options,actor:newLogin,target:restored})).body.code,'RECOVERY_REQUIRED');assert.equal((await post(q.path+'/share',body,{...options,actor:newLogin,target:restored,recoveryEpoch:newEpoch})).body.code,'RECOVERY_REQUIRED');
});
test('public IP quota covers malformed tokens and cannot be bypassed by spoofing forwarding headers',async()=>{
 assert.equal((await view('bad')).status,404);const bucket=await db.client.rateLimitBucket.findFirst({where:{scope:'public_view'}});assert.ok(bucket);
 await db.client.rateLimitBucket.update({where:{scope_keyDigest_windowStart:{scope:bucket.scope,keyDigest:bucket.keyDigest,windowStart:bucket.windowStart}},data:{count:120}});
 const r=await request(app).post('/api/v1/public/quotation-view').set('X-Forwarded-For','192.0.2.42').send({token:'bad'});assert.equal(r.status,429);assert.ok(Number(r.headers['retry-after'])>0);
});
test('revision and publication preserve copied inactive catalog bases and explicit overrides',async()=>{
 const q=await create(false),item=await db.client.catalogItem.create({data:{name:'Original',unit:'m',unitPriceVnd:100n}}),body={...empty(),lines:[{lineId:key(),kind:'CATALOG',description:'Copied',quantity:'1',sourceCatalogId:item.id,sourceRevision:1,overrideUnitPrice:'90'}]};
 const saved=await request(app).put('/api/v1'+q.path+'/draft').set('Cookie',cookie(session)).set('Origin',origin).set('X-CSRF-Token',session.body.csrfToken).set('X-Recovery-Epoch',epoch).set('Idempotency-Key',key()).set('If-Match',(await read(q)).etag).send(body);assert.equal(saved.status,200);
 await db.client.catalogItem.update({where:{id:item.id},data:{active:false,unit:'set',unitPriceVnd:999n,revision:2}});assert.equal((await share(q)).status,200);
 const revision=await post(`/quotations/${q.q}/revisions`,{},{etag:(await get(`/quotations/${q.q}`)).body.etag}),v=revision.body.operation.resourceIds.versionId,next={q:q.q,v,path:`/quotations/${q.q}/versions/${v}`},draft=await read(next);
 assert.equal('companySnapshot' in draft,false);assert.equal(draft.lines[0].baseUnitPrice,'100');assert.equal(draft.lines[0].overrideUnitPrice,'90');assert.equal(draft.lines[0].unit,'m');assert.equal(draft.lines[0].sourceRevision,1);assert.equal((await share(next)).status,200);const publicRead=await view(new URL((await link(next)).url).hash.slice(1));assert.equal(publicRead.body.total,'90');assert.equal(publicRead.body.lines[0].unitPrice,'90');assert.equal('sourceCatalogId' in publicRead.body.lines[0],false);
});
test('expired review is rejected while identical successful share replay ignores review expiry',async()=>{
 const q=await create(),r=await review(q),original=AuthRepository.prototype.clock,body={reviewToken:r.body.reviewToken},options={etag:r.body.draftETag,operationKey:key()};
 try{AuthRepository.prototype.clock=async function(tx){return new Date((await original.call(this,tx)).getTime()+600001);};assert.equal((await post(q.path+'/share',body,options)).body.code,'REVIEW_STALE');}finally{AuthRepository.prototype.clock=original;}
 assert.equal((await post(q.path+'/share',body,options)).status,200);const l=await link(q);
 try{AuthRepository.prototype.clock=async function(tx){return new Date((await original.call(this,tx)).getTime()+600001);};assert.equal((await post(q.path+'/share',body,options)).status,200);}finally{AuthRepository.prototype.clock=original;}
 assert.deepEqual(await link(q),l);
});
test('public lookup rechecks expiry and revocation after waiting on an exclusive quotation lock',async()=>{
 const {default:pg}=await import('pg'),control=new pg.Client({connectionString:testUrl});await control.connect();
 const q=await create();assert.equal((await share(q)).status,200);let pending;
 try{for(const reason of ['revoked','expired']){
  if(reason==='expired')assert.equal((await post(q.path+'/access/replace',{},{etag:(await access(q)).etag})).status,200);
  const token=new URL((await link(q)).url).hash.slice(1);
  await control.query('BEGIN');await control.query('SELECT id FROM quotation WHERE id=$1 FOR UPDATE',[q.q]);pending=view(token).then(r=>r);let blocked=false;
  for(let attempt=0;attempt<200;attempt++){
   // pg_stat_activity snapshots are cached inside this control transaction.
   await control.query('SELECT pg_stat_clear_snapshot()');
   const waits=await control.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%quotation%FOR SHARE%'");if(Number(waits.rows[0].count)>0){blocked=true;break;}await new Promise(r=>setTimeout(r,10));
  }assert.equal(blocked,true);
  if(reason==='revoked')await control.query('UPDATE viewing_access SET revoked_at=clock_timestamp(),token_ciphertext=NULL,token_nonce=NULL,token_tag=NULL,encryption_key_id=NULL WHERE quotation_id=$1',[q.q]);
  else{await control.query("WITH expiry AS (SELECT clock_timestamp()+interval '100 milliseconds' AS instant) UPDATE viewing_access SET expires_at=expiry.instant,issued_at=expiry.instant-interval '720 hours' FROM expiry WHERE quotation_id=$1",[q.q]);await new Promise(r=>setTimeout(r,250));}
  await control.query('COMMIT');assert.equal((await pending).body.code,'LINK_UNAVAILABLE');pending=undefined;
 }}finally{await control.query('ROLLBACK');if(pending)await pending;await control.end();}
});
test('disable after initial publication authorization prevents share commit',async()=>{
 const q=await create(),r=await review(q),original=PublicationService.prototype.share;let entered,release;const ready=new Promise(resolve=>entered=resolve),barrier=new Promise(resolve=>release=resolve);
 PublicationService.prototype.share=async function(...args){entered();await barrier;return original.apply(this,args);};const pending=post(q.path+'/share',{reviewToken:r.body.reviewToken},{etag:r.body.draftETag}).then(r=>r);
 try{await ready;await db.client.staffUser.update({where:{id:employee.id},data:{enabled:false,revision:{increment:1}}});release();assert.equal((await pending).status,401);assert.equal((await get(q.path,adminSession)).body.state,'DRAFT');assert.equal(await db.client.viewingAccess.count(),0);}finally{release();PublicationService.prototype.share=original;await pending;}
});
test('missing or corrupt viewing encryption keys fail closed without altering current access',async()=>{
 const q=await create();assert.equal((await share(q)).status,200);const l=await link(q),a=await access(q),missing=createApp({...config,viewingKeys:new Map([['other',Buffer.alloc(32,8)]])},db);
 const denied=await get(q.path+'/access/link',session,missing).set('If-Match',a.etag);assert.equal(denied.status,503);assert.equal(JSON.stringify(denied.body).includes(new URL(l.url).hash.slice(1)),false);
 const rotated=createApp({...config,viewingKeyId:'v2',viewingKeys:new Map([...config.viewingKeys,['v2',Buffer.alloc(32,8)]])},db);assert.equal((await get(q.path+'/access/link',session,rotated).set('If-Match',a.etag)).body.url,l.url);assert.deepEqual(await link(q),l);
});
