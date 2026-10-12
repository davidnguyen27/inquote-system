import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {parseConfig} from '../../dist/config/env.js';
import {fixtureConfig,origin} from '../helpers.mjs';
const values=()=>({DATABASE_URL:'postgresql://synthetic@127.0.0.1:1/auth_test',ADMIN_ORIGIN:origin,USER_ORIGIN:'https://quote.example.test',RECOVERY_EPOCH:'71000000-0000-4000-8000-000000000001',CSRF_HMAC_KEY:Buffer.alloc(32,1).toString('base64'),RATE_LIMIT_HMAC_KEY:Buffer.alloc(32,2).toString('base64'),REVIEW_HMAC_KEY:Buffer.alloc(32,3).toString('base64'),OPERATION_HMAC_KEYS:JSON.stringify({v1:Buffer.alloc(32,4).toString('base64')}),OPERATION_HMAC_CURRENT_KEY_ID:'v1',VIEWING_LINK_KEYS:JSON.stringify({v1:Buffer.alloc(32,5).toString('base64')}),VIEWING_LINK_CURRENT_KEY_ID:'v1'});
test('runtime rejects missing/invalid/reused keys and unsafe origins/proxies',()=>{
  assert.equal(fixtureConfig().trustProxy,false);
  for(const change of [{DATABASE_URL:''},{DATABASE_URL:'postgresql://YOUR_USERNAME:YOUR_PASSWORD@localhost/YOUR_DATABASE'},{CSRF_HMAC_KEY:'invalid'},{RATE_LIMIT_HMAC_KEY:values().CSRF_HMAC_KEY},{OPERATION_HMAC_CURRENT_KEY_ID:'missing'},{OPERATION_HMAC_KEYS:'[]'},{RECOVERY_EPOCH:'bad'},{ADMIN_ORIGIN:'http://admin.example.test'},{ADMIN_ORIGIN:origin+'/path'},{USER_ORIGIN:origin},{TRUST_PROXY:'true'},{TRUST_PROXY:'1'},{TRUST_PROXY:'127.0.0.1/24/1'},{TRUST_PROXY:'::1/129'},{PORT:'0'}])assert.throws(()=>parseConfig({...values(),...change}));
  assert.deepEqual(parseConfig({...values(),TRUST_PROXY:'127.0.0.1,10.0.0.0/24,::1'}).trustProxy,['127.0.0.1','10.0.0.0/24','::1']);
});
test('API docs require explicit boolean configuration and default to disabled',()=>{
  assert.equal(parseConfig(values()).apiDocsEnabled,false);
  assert.equal(parseConfig({...values(),ENABLE_API_DOCS:'false'}).apiDocsEnabled,false);
  assert.equal(parseConfig({...values(),ENABLE_API_DOCS:'true'}).apiDocsEnabled,true);
  for(const value of ['', 'yes', '1', 'TRUE'])assert.throws(()=>parseConfig({...values(),ENABLE_API_DOCS:value}));
});

test('database configuration accepts real components containing placeholder-like substrings',()=>{
  for(const url of ['postgresql://your_company:REPLACE_me_later_123@localhost/your_company','postgresql://real:YOUR_secure_password@localhost/auth_test'])assert.equal(parseConfig({...values(),DATABASE_URL:url}).databaseUrl,url);
  for(const url of ['postgresql://YOUR_USERNAME:real@localhost/auth_test','postgresql://real:YOUR_PASSWORD@localhost/auth_test','postgresql://real@localhost/YOUR_DATABASE','postgresql://real@localhost/auth_test?schema=','postgresql://real@localhost/auth_test?schema='+encodeURIComponent('x'.repeat(64))])assert.throws(()=>parseConfig({...values(),DATABASE_URL:url}));
});
test('DTO validation rejects original own constructor and __proto__ keys',async()=>{
  const {LoginDto,ChangePasswordDto,EmptyDto,parseDto}=await import('../../dist/modules/auth/auth.dto.js');
  for(const Type of [LoginDto,ChangePasswordDto,EmptyDto])for(const name of ['constructor','__proto__']){
    const allowed=Type===ChangePasswordDto?{currentPassword:'current',newPassword:'new'}:{};
    const body=JSON.parse(JSON.stringify({...allowed,[name]:{role:'ADMINISTRATOR'}}));
    await assert.rejects(()=>parseDto(Type,body),e=>e.code==='INVALID_REQUEST');
  }
});
test('OpenAPI 3.1.1 validates all 33 staff quotation lifecycle and public operations',async()=>{
  const spec=JSON.parse(readFileSync(new URL('../../openapi/auth.openapi.json',import.meta.url),'utf8'));
  const {default:SwaggerParser}=await import('@apidevtools/swagger-parser');
  await SwaggerParser.validate(structuredClone(spec));
  assert.equal(spec.openapi,'3.1.1');
  assert.deepEqual(Object.keys(spec.paths).sort(),['/auth/change-password','/auth/login','/auth/logout','/auth/session','/catalog-items','/catalog-items/{id}','/company','/operations/{key}','/public/quotation-view','/quotations','/quotations/{q}','/quotations/{q}/revisions','/quotations/{q}/versions','/quotations/{q}/versions/{v}','/quotations/{q}/versions/{v}/access','/quotations/{q}/versions/{v}/access/link','/quotations/{q}/versions/{v}/access/replace','/quotations/{q}/versions/{v}/access/revoke','/quotations/{q}/versions/{v}/draft','/quotations/{q}/versions/{v}/draft-preview','/quotations/{q}/versions/{v}/lines/{line}/price-refresh-preview','/quotations/{q}/versions/{v}/share','/quotations/{q}/versions/{v}/share-review','/staff','/staff/{id}','/staff/{id}/credential-reset']);
  assert.equal(Object.values(spec.paths).reduce((count,path)=>count+Object.keys(path).filter(method=>['get','post','put','delete'].includes(method)).length,0),33);
  assert.equal(spec.info.version,'1.4.0');
  assert.deepEqual(spec.paths['/public/quotation-view'].post.security,[]);
  assert.equal(spec.components.schemas.PublicQuotation.additionalProperties,false);
  assert.deepEqual(Object.keys(spec.components.schemas.PublicQuotation.properties.customer.properties),['name']);
  assert.equal(spec.components.schemas.ShareWrite.additionalProperties,false);
  assert.equal(spec.components.schemas.PublicViewWrite.additionalProperties,false);
  assert.equal(spec.components.schemas.DraftWrite.additionalProperties,false);
  assert.equal(spec.components.schemas.DraftWrite.properties.lines.maxItems,1000);
  assert.equal(spec.components.schemas.CustomLineWrite.additionalProperties,false);
  assert.equal(spec.components.schemas.DraftRead.properties.state.const,'DRAFT');
  assert.equal(spec.components.schemas.StaffCreateWrite.additionalProperties,false);
  assert.equal('role' in spec.components.schemas.StaffCreateWrite.properties,false);
  assert.equal(spec.components.schemas.ChangePasswordWrite.additionalProperties,false);
  assert.equal(spec.components.securitySchemes.StaffSession.name,'__Host-inquote_session');
});
