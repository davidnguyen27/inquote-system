import assert from 'node:assert/strict';
import test, {before,after,beforeEach} from 'node:test';
import request from 'supertest';
import {Database} from '../../dist/database/prisma.js';
import {createApp} from '../../dist/app.js';
import {PasswordService} from '../../dist/modules/auth/password.service.js';
import {CommonMutationService} from '../../dist/modules/common/common-data.js';
import {fixtureConfig,testUrl,origin,password,epoch,key} from '../helpers.mjs';
if(!testUrl || !new URL(testUrl).pathname.endsWith('_test')) throw Error('Dedicated TEST_DATABASE_URL ending in _test required.');
const db=new Database(testUrl), app=createApp(fixtureConfig(),db);
let hash,admin,employee,session,employeeSession;
const cookie=r=>r.headers['set-cookie'][0].split(';')[0];
const login=email=>request(app).post('/api/v1/auth/login').set('Origin',origin).send({email,password});
const get=(path,actor=session)=>request(app).get(path).set('Cookie',cookie(actor));
const write=(method,path,body,{actor=session,operationKey=key(),etag,recoveryEpoch=epoch,csrf=actor.body.csrfToken,application=app}={})=>{
  const req=request(application)[method](path).set('Cookie',cookie(actor)).set('Origin',origin).set('X-CSRF-Token',csrf).set('Idempotency-Key',operationKey).set('X-Recovery-Epoch',recoveryEpoch);
  if(etag)req.set('If-Match',etag);
  return req.send(body);
};
const company={displayName:' Synthetic Interiors ',address:' ',phone:null,email:' contact@example.test '};
const catalog={name:' Cabinet ',description:' ',unit:' m² ',unitPrice:'000123456',active:true};
before(async()=>hash=await new PasswordService().hash(password));
after(async()=>db.close());
beforeEach(async()=>{
  await db.client.operationReceipt.deleteMany();await db.client.staffSession.deleteMany();await db.client.rateLimitBucket.deleteMany();await db.client.staffUser.deleteMany();await db.client.catalogItem.deleteMany();
  await db.client.companyProfile.update({where:{id:1},data:{displayName:null,address:null,phone:null,email:null,revision:1}});
  admin=await db.client.staffUser.create({data:{displayName:'Synthetic Admin',normalizedEmail:'admin@example.test',role:'ADMINISTRATOR',passwordHash:hash}});
  employee=await db.client.staffUser.create({data:{displayName:'Synthetic Employee',normalizedEmail:'employee@example.test',passwordHash:hash}});
  session=await login(admin.normalizedEmail);employeeSession=await login(employee.normalizedEmail);
});

test('company replacement normalizes optional fields and returns a recoverable revision receipt',async()=>{
  const initial=await get('/api/v1/company',employeeSession);assert.equal(initial.status,200);assert.equal(initial.body.id,1);assert.equal(initial.headers.etag,initial.body.etag);
  const intent=key(),saved=await write('put','/api/v1/company',company,{etag:initial.body.etag,operationKey:intent});assert.equal(saved.status,200);assert.equal(saved.body.operation.kind,'UPDATE_COMPANY');assert.deepEqual(saved.body.operation.appliedRevisions,{company:2});
  const read=await get('/api/v1/company');assert.equal(read.body.displayName,'Synthetic Interiors');assert.equal(read.body.address,null);assert.equal(read.body.email,'contact@example.test');assert.notEqual(read.body.etag,initial.body.etag);
  assert.deepEqual((await write('put','/api/v1/company',company,{etag:initial.body.etag,operationKey:intent})).body,saved.body);
  assert.equal((await write('put','/api/v1/company',company,{etag:initial.body.etag})).status,412);
  const receipt=await get('/api/v1/operations/'+intent); // Epoch is required for operation lookup.
  assert.equal(receipt.status,409);
  const recovered=await get('/api/v1/operations/'+intent).set('X-Recovery-Epoch',epoch);assert.equal(recovered.status,200);assert.deepEqual(recovered.body,saved.body.operation);
});

test('catalog creation and replacement preserve exact bigint price, source revision and receipt replay',async()=>{
  const intent=key(),created=await write('post','/api/v1/catalog-items',catalog,{operationKey:intent});assert.equal(created.status,201);
  const id=created.body.operation.resourceIds.catalogItemId,read=await get('/api/v1/catalog-items/'+id);assert.equal(read.status,200);assert.equal(read.body.unitPrice,'123456');assert.equal(read.body.sourceRevision,1);assert.equal(read.headers.etag,read.body.etag);assert.equal(read.body.description,null);
  assert.equal((await db.client.catalogItem.findUnique({where:{id}})).unitPriceVnd,123456n);
  assert.deepEqual((await write('post','/api/v1/catalog-items',catalog,{operationKey:intent})).body,created.body);
  const update={...catalog,unitPrice:'1000000000000',active:false},updateKey=key(),changed=await write('put','/api/v1/catalog-items/'+id,update,{etag:read.body.etag,operationKey:updateKey});assert.equal(changed.status,200);
  assert.deepEqual((await write('put','/api/v1/catalog-items/'+id,update,{etag:read.body.etag,operationKey:updateKey})).body,changed.body);
  const current=await get('/api/v1/catalog-items/'+id.toUpperCase());assert.equal(current.body.unitPrice,'1000000000000');assert.equal(current.body.sourceRevision,2);
  assert.equal((await get('/api/v1/catalog-items/'+id,employeeSession)).status,404);
  assert.equal((await get('/api/v1/catalog-items',employeeSession)).body.items.length,0);
  assert.equal((await get('/api/v1/catalog-items?active=false',employeeSession)).status,403);
  assert.equal((await get('/api/v1/catalog-items?active=false')).body.items.length,1);
});

test('catalog pagination binds filters and accepts maximum Unicode search and name',async()=>{
  const name='😀'.repeat(200);
  for(let i=0;i<3;i++)assert.equal((await write('post','/api/v1/catalog-items',{...catalog,name,active:i!==2})).status,201);
  const first=await get('/api/v1/catalog-items').query({limit:1,search:name,active:true});assert.equal(first.status,200);assert.ok(first.body.nextCursor);
  const next=await get('/api/v1/catalog-items').query({limit:1,search:name,active:true,cursor:first.body.nextCursor});assert.equal(next.status,200);assert.notEqual(next.body.items[0].id,first.body.items[0].id);assert.equal(next.body.nextCursor,null);
  for(const query of [{limit:1,search:name,active:false,cursor:first.body.nextCursor},{limit:1,search:name,active:true,cursor:first.body.nextCursor+'x'},{limit:101},{active:'yes'},{search:'😀'.repeat(201)},{unknown:'x'}])assert.equal((await get('/api/v1/catalog-items').query(query)).status,400);
});

test('common-data mutations enforce role, session gates, CSRF, epoch, strong tags and strict input',async()=>{
  const initial=await get('/api/v1/company');
  assert.equal((await write('put','/api/v1/company',company,{actor:employeeSession,etag:initial.body.etag})).status,403);
  assert.equal((await write('post','/api/v1/catalog-items',catalog,{actor:employeeSession})).status,403);
  await db.client.staffUser.update({where:{id:employee.id},data:{mustChangePassword:true,temporaryCredentialExpiresAt:new Date(Date.now()+86400000)}});
  const limited=await login(employee.normalizedEmail);for(const path of ['/api/v1/company','/api/v1/catalog-items']){const r=await get(path,limited);assert.equal(r.status,403);assert.equal(r.body.code,'PASSWORD_CHANGE_REQUIRED');}
  assert.equal((await write('put','/api/v1/company',company)).status,428);
  for(const etag of ['*','W/'+initial.body.etag,initial.body.etag+', '+initial.body.etag])assert.equal((await write('put','/api/v1/company',company,{etag})).status,428);
  assert.equal((await write('post','/api/v1/catalog-items',catalog,{csrf:'wrong'})).status,403);
  assert.equal((await write('post','/api/v1/catalog-items',catalog,{recoveryEpoch:key()})).status,409);
  assert.equal((await write('post','/api/v1/catalog-items',catalog,{operationKey:'bad'})).status,400);
  for(const body of [{...catalog,id:key()},{...catalog,unitPrice:123456},{...catalog,description:undefined},{...catalog,prototype:'x'},JSON.parse('{"name":"X","description":null,"unit":"m","unitPrice":"0","active":true,"__proto__":{}}')])assert.equal((await write('post','/api/v1/catalog-items',body)).status,400);
  for(const body of [{...company,phone:undefined},{...company,revision:3}])assert.equal((await write('put','/api/v1/company',body,{etag:initial.body.etag})).status,400);
  assert.equal(await db.client.operationReceipt.count(),0);
});

test('unstorable text is rejected before company or catalog mutation with field pointers',async()=>{
  const initial=await get('/api/v1/company');
  for(const invalid of ['before\u0000after','before\ud800after','before\udfffafter']){
    for(const field of ['displayName','address','phone','email']){
      const response=await write('put','/api/v1/company',{...company,[field]:invalid},{etag:initial.body.etag});
      assert.equal(response.status,422,field);assert.equal(response.body.errors[0].pointer,'/'+field);
    }
    for(const field of ['name','description','unit']){
      const response=await write('post','/api/v1/catalog-items',{...catalog,[field]:invalid});
      assert.equal(response.status,422,field);assert.equal(response.body.errors[0].pointer,'/'+field);
    }
  }
  assert.equal((await get('/api/v1/company')).body.etag,initial.body.etag);assert.equal(await db.client.catalogItem.count(),0);assert.equal(await db.client.operationReceipt.count(),0);
});

test('catalog search rejects NUL and preserves ordinary newlines and astral text',async()=>{
  const invalid=await get('/api/v1/catalog-items').query({search:'before\u0000after'});assert.equal(invalid.status,400);assert.equal(invalid.body.code,'INVALID_REQUEST');
  const body={...catalog,name:' Line\n😀 ',description:' Description\n😀 ',unit:' 😀 '},created=await write('post','/api/v1/catalog-items',body);assert.equal(created.status,201);
  const read=await get('/api/v1/catalog-items/'+created.body.operation.resourceIds.catalogItemId);assert.equal(read.body.name,'Line\n😀');assert.equal(read.body.description,'Description\n😀');assert.equal(read.body.unit,'😀');
  const found=await get('/api/v1/catalog-items').query({search:' Line\n😀 '});assert.equal(found.status,200);assert.equal(found.body.items.length,1);
});

test('catalog rejects malformed prices and character ceilings with field pointers',async()=>{
  for(const unitPrice of ['','-1','1e3','100.5','1000000000001','NaN',' 1 ']){const r=await write('post','/api/v1/catalog-items',{...catalog,unitPrice});assert.equal(r.status,422);assert.equal(r.body.errors[0].pointer,'/unitPrice');}
  for(const [field,value] of [['name',' '],['name','😀'.repeat(201)],['unit',''],['unit','😀'.repeat(51)],['description','😀'.repeat(501)]]){const r=await write('post','/api/v1/catalog-items',{...catalog,[field]:value});assert.equal(r.status,422);assert.equal(r.body.errors[0].pointer,'/'+field);}
  const read=await get('/api/v1/company');for(const [field,value] of [['displayName','😀'.repeat(201)],['address','x'.repeat(501)],['phone','x'.repeat(51)],['email','bad']]){const r=await write('put','/api/v1/company',{...company,[field]:value},{etag:read.body.etag});assert.equal(r.status,422);assert.equal(r.body.errors[0].pointer,'/'+field);}
  assert.equal(await db.client.operationReceipt.count(),0);
});

test('concurrent identical keys create one catalog row; changed exact input and cross-resource keys conflict',async()=>{
  const intent=key(),responses=await Promise.all([write('post','/api/v1/catalog-items',catalog,{operationKey:intent}),write('post','/api/v1/catalog-items',catalog,{operationKey:intent})]);for(const r of responses)assert.equal(r.status,201);assert.deepEqual(responses[0].body,responses[1].body);assert.equal(await db.client.catalogItem.count(),1);assert.equal(await db.client.operationReceipt.count(),1);
  for(const body of [{...catalog,name:'Cabinet'},{...catalog,unitPrice:'123456'},{...catalog,unitPrice:'-1'}]){const r=await write('post','/api/v1/catalog-items',body,{operationKey:intent});assert.equal(r.status,409);assert.equal(r.body.code,'IDEMPOTENCY_KEY_REUSED');}
  const read=await get('/api/v1/company');assert.equal((await write('put','/api/v1/company',company,{etag:read.body.etag,operationKey:intent})).status,409);
});

test('receipt failure rolls back common-data replacement and leaves the original ETag usable',async()=>{
  const read=await get('/api/v1/company');
  await db.client.$executeRawUnsafe("CREATE FUNCTION test_common_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind = 'UPDATE_COMPANY' THEN RAISE EXCEPTION 'synthetic receipt failure'; END IF; RETURN NEW; END $$");
  await db.client.$executeRawUnsafe('CREATE TRIGGER test_common_receipt_failure BEFORE INSERT ON operation_receipt FOR EACH ROW EXECUTE FUNCTION test_common_receipt_failure()');
  try{assert.equal((await write('put','/api/v1/company',company,{etag:read.body.etag})).status,500);assert.equal(await db.client.operationReceipt.count(),0);const row=await db.client.companyProfile.findUnique({where:{id:1}});assert.equal(row.revision,1);assert.equal(row.displayName,null);}finally{await db.client.$executeRawUnsafe('DROP TRIGGER test_common_receipt_failure ON operation_receipt');await db.client.$executeRawUnsafe('DROP FUNCTION test_common_receipt_failure()');}
  assert.equal((await write('put','/api/v1/company',company,{etag:read.body.etag})).status,200);
});

test('common-data receipt replay retains historical HMAC keys and requires the original epoch and precondition',async()=>{
  const initial=await get('/api/v1/company'),intent=key(),saved=await write('put','/api/v1/company',company,{etag:initial.body.etag,operationKey:intent});assert.equal(saved.status,200);
  const config=fixtureConfig();config.operationKeys=new Map([...config.operationKeys,['v2',Buffer.alloc(32,6)]]);config.operationKeyId='v2';
  assert.deepEqual((await write('put','/api/v1/company',company,{etag:initial.body.etag,operationKey:intent,application:createApp(config,db)})).body,saved.body);
  config.operationKeys.delete('v1');assert.equal((await write('put','/api/v1/company',company,{etag:initial.body.etag,operationKey:intent,application:createApp(config,db)})).status,503);
  const current=await get('/api/v1/company');assert.equal((await write('put','/api/v1/company',company,{etag:current.body.etag,operationKey:intent})).status,409);
  await db.client.operationReceipt.update({where:{actorId_idempotencyKey:{actorId:admin.id,idempotencyKey:intent}},data:{recoveryEpoch:key()}});assert.equal((await write('put','/api/v1/company',company,{etag:initial.body.etag,operationKey:intent})).body.code,'RECOVERY_REQUIRED');
});

test('competing administrators cannot overwrite company or catalog with the same stale revision',async()=>{
  const other=await db.client.staffUser.create({data:{displayName:'Other Admin',normalizedEmail:'other@example.test',role:'ADMINISTRATOR',passwordHash:hash}}),actor=await login(other.normalizedEmail);
  const companyRead=await get('/api/v1/company');
  const results=await Promise.all([write('put','/api/v1/company',{...company,displayName:'First'},{etag:companyRead.body.etag}),write('put','/api/v1/company',{...company,displayName:'Second'},{actor,etag:companyRead.body.etag})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,412]);assert.equal((await get('/api/v1/company')).body.revision,2);
  const created=await write('post','/api/v1/catalog-items',catalog),id=created.body.operation.resourceIds.catalogItemId,read=await get('/api/v1/catalog-items/'+id);
  const updates=await Promise.all([write('put','/api/v1/catalog-items/'+id,{...catalog,unitPrice:'1'},{etag:read.body.etag}),write('put','/api/v1/catalog-items/'+id,{...catalog,unitPrice:'2'},{actor,etag:read.body.etag})]);
  assert.deepEqual(updates.map(r=>r.status).sort(),[200,412]);assert.equal((await get('/api/v1/catalog-items/'+id)).body.revision,2);
  assert.equal(await db.client.operationReceipt.count(),3);
});

test('catalog receipt storage failure rolls back both creation and replacement',async()=>{
  const existing=await db.client.catalogItem.create({data:{name:'Existing',unit:'item',unitPriceVnd:5n}}),read=await get('/api/v1/catalog-items/'+existing.id);
  await db.client.$executeRawUnsafe("CREATE FUNCTION test_catalog_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind IN ('CREATE_CATALOG_ITEM','UPDATE_CATALOG_ITEM') THEN RAISE EXCEPTION 'synthetic receipt failure'; END IF; RETURN NEW; END $$");
  await db.client.$executeRawUnsafe('CREATE TRIGGER test_catalog_receipt_failure BEFORE INSERT ON operation_receipt FOR EACH ROW EXECUTE FUNCTION test_catalog_receipt_failure()');
  try{
    assert.equal((await write('post','/api/v1/catalog-items',catalog)).status,500);assert.equal(await db.client.catalogItem.count(),1);
    assert.equal((await write('put','/api/v1/catalog-items/'+existing.id,catalog,{etag:read.body.etag})).status,500);
    const row=await db.client.catalogItem.findUnique({where:{id:existing.id}});assert.equal(row.revision,1);assert.equal(row.unitPriceVnd,5n);assert.equal(row.name,'Existing');assert.equal(await db.client.operationReceipt.count(),0);
  }finally{await db.client.$executeRawUnsafe('DROP TRIGGER test_catalog_receipt_failure ON operation_receipt');await db.client.$executeRawUnsafe('DROP FUNCTION test_catalog_receipt_failure()');}
});

test('catalog receipts remain actor-scoped and resource-scoped after inactivation',async()=>{
  const intent=key(),created=await write('post','/api/v1/catalog-items',catalog,{operationKey:intent}),id=created.body.operation.resourceIds.catalogItemId;
  const other=await db.client.staffUser.create({data:{displayName:'Other Admin',normalizedEmail:'other@example.test',role:'ADMINISTRATOR',passwordHash:hash}}),actor=await login(other.normalizedEmail);
  assert.equal((await get('/api/v1/operations/'+intent,actor).set('X-Recovery-Epoch',epoch)).status,404);
  assert.equal((await get('/api/v1/operations/'+intent,employeeSession).set('X-Recovery-Epoch',epoch)).status,404);
  const second=await write('post','/api/v1/catalog-items',catalog,{actor,operationKey:intent});assert.equal(second.status,201);assert.notEqual(second.body.operation.resourceIds.catalogItemId,id);
  const read=await get('/api/v1/catalog-items/'+id),updateKey=key(),body={...catalog,active:false},updated=await write('put','/api/v1/catalog-items/'+id,body,{etag:read.body.etag,operationKey:updateKey});assert.equal(updated.status,200);
  const recovered=await get('/api/v1/operations/'+updateKey).set('X-Recovery-Epoch',epoch);assert.deepEqual(recovered.body,updated.body.operation);
  assert.equal((await write('put','/api/v1/catalog-items/'+second.body.operation.resourceIds.catalogItemId,body,{etag:read.body.etag,operationKey:updateKey})).status,409);
  assert.deepEqual((await write('put','/api/v1/catalog-items/'+id,body,{etag:read.body.etag,operationKey:updateKey})).body,updated.body);
});

test('common-data commit rechecks account disable after initial request authorization',async()=>{
  let enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve),original=CommonMutationService.prototype.write;
  CommonMutationService.prototype.write=async function(...args){enter();await gate;return original.apply(this,args);};
  const pending=write('post','/api/v1/catalog-items',catalog).then(r=>r);
  try{
    await entered;await db.client.staffUser.update({where:{id:admin.id},data:{enabled:false,revision:{increment:1}}});release();
    assert.equal((await pending).status,401);assert.equal(await db.client.catalogItem.count(),0);assert.equal(await db.client.operationReceipt.count(),0);
  }finally{release();CommonMutationService.prototype.write=original;await pending;}
});

test('company and catalog changes leave saved quotation copies and overrides unchanged',async()=>{
  const created=await write('post','/api/v1/catalog-items',catalog),id=created.body.operation.resourceIds.catalogItemId,read=await get('/api/v1/catalog-items/'+id),profile=await get('/api/v1/company');
  const snapshot={currency:'VND',companySnapshot:{displayName:'Old Company'},lines:[{id:key(),kind:'CATALOG',catalogItemId:id,sourceRevision:1,baseUnitPrice:'123456',overrideUnitPrice:'100000',quantity:'1.25',unitPrice:'100000',amount:'125000'}],total:'125000'};
  const rollback=new Error('Rollback synthetic quotation fixture');
  await assert.rejects(db.transaction(async tx=>{
    const quote=await tx.quotation.create({data:{ownerId:employee.id,lastAllocatedNumber:2}});
    const shared=await tx.quotationVersion.create({data:{quotationId:quote.id,number:1,state:'SHARED',sharedAt:new Date(),content:snapshot}});
    await tx.quotation.update({where:{id:quote.id},data:{latestSharedVersionId:shared.id}});
    const version=await tx.quotationVersion.create({data:{quotationId:quote.id,number:2,content:snapshot}});
    assert.equal((await write('put','/api/v1/company',company,{etag:profile.body.etag})).status,200);
    assert.equal((await write('put','/api/v1/catalog-items/'+id,{...catalog,unitPrice:'999999',active:false},{etag:read.body.etag})).status,200);
    const after=await tx.quotationVersion.findUnique({where:{id:version.id}});assert.deepEqual(after.content,snapshot);assert.equal(after.revision,1);
    assert.deepEqual((await tx.quotationVersion.findUnique({where:{id:shared.id}})).content,snapshot);
    throw rollback;
  }),error=>error===rollback);
});
