import assert from 'node:assert/strict';
import test from 'node:test';
import {validateText,validateEmail,accountEmailIdentity} from '../../dist/domain/text.js';
import {textField,emailField} from '../../dist/http/text-validation.js';
import {AuthService} from '../../dist/modules/auth/auth.service.js';
import {PasswordService} from '../../dist/modules/auth/password.service.js';
import {fixtureConfig,password} from '../helpers.mjs';

test('ordinary text trims boundaries without coercion or internal normalization',()=>{
 for(const [value,want] of [[null,null],['  ',null],['  😀\nA e\u0301  ','😀\nA e\u0301']])assert.deepEqual(validateText(value,{maxCodePoints:200}),{ok:true,value:want});
 for(const value of [undefined,42,false,[],{},new String('text')])assert.deepEqual(validateText(value,{maxCodePoints:200}),{ok:false,reason:'INVALID_TYPE'});
 for(const value of [null,'','  '])assert.deepEqual(validateText(value,{maxCodePoints:200,required:true}),{ok:false,reason:'REQUIRED'});
});

test('text ceilings count Unicode code points including astral and combining text',()=>{
 for(const max of [50,200,254,500,5000]){
  assert.deepEqual(validateText(' '+ '😀'.repeat(max)+' ',{maxCodePoints:max,required:true}),{ok:true,value:'😀'.repeat(max)});
  assert.deepEqual(validateText('😀'.repeat(max+1),{maxCodePoints:max}),{ok:false,reason:'TOO_LONG'});
 }
 assert.deepEqual(validateText('e\u0301',{maxCodePoints:2}),{ok:true,value:'e\u0301'});
 assert.deepEqual(validateText('e\u0301',{maxCodePoints:1}),{ok:false,reason:'TOO_LONG'});
});

test('invalid Unicode is rejected as data without exposing the supplied text',()=>{
 for(const value of ['A\u0000B','A\ud800B','A\udfffB']){
  assert.deepEqual(validateText(value,{maxCodePoints:200}),{ok:false,reason:'INVALID_UNICODE'});
  for(const profile of ['account','contact'])for(const email of [value+'@example.test','a@'+value+'.test'])assert.deepEqual(validateEmail(email,profile),{ok:false,reason:'INVALID_UNICODE'});
 }
});

test('account email and quota identity share normalization without provider rewriting',()=>{
 assert.deepEqual(validateEmail(' A.User+Tag@EXAMPLE.TEST ','account'),{ok:true,value:'a.user+tag@example.test'});
 for(const value of [null,undefined,'','   '])assert.deepEqual(validateEmail(value,'account'),{ok:false,reason:'REQUIRED'});
 assert.deepEqual(validateEmail('bad email','account'),{ok:false,reason:'INVALID_EMAIL'});
 assert.equal(accountEmailIdentity(' A.User+Tag@EXAMPLE.TEST '),'a.user+tag@example.test');
 assert.equal(accountEmailIdentity(' A\ud800B@EXAMPLE.TEST '),'a\ud800b@example.test');
 assert.equal(accountEmailIdentity(null),'');
});

test('contact email preserves case and the existing email-validator syntax restrictions',()=>{
 for(const value of [null,'','  '])assert.deepEqual(validateEmail(value,'contact'),{ok:true,value:null});
 for(const value of ['Contact@Example.test','a@😀.com','"a\nb"@example.com','é'.repeat(32)+'@example.com'])assert.deepEqual(validateEmail(' '+value+' ','contact'),{ok:true,value});
 for(const value of ['é'.repeat(33)+'@example.com','😀@example.com','a@localhost','a@under_score.com'])assert.deepEqual(validateEmail(value,'contact'),{ok:false,reason:'INVALID_EMAIL'});
 const edge='a@'+('b'.repeat(63)+'.').repeat(3)+'w'.repeat(56)+'.com';
 assert.equal(edge.length,254);assert.deepEqual(validateEmail(edge,'contact'),{ok:true,value:edge});
 const utf16Edge='a@'+('b'.repeat(63)+'.').repeat(3)+'😀'+'w'.repeat(55)+'.com';
 assert.equal([...utf16Edge].length,254);assert.deepEqual(validateEmail(utf16Edge,'contact'),{ok:false,reason:'INVALID_EMAIL'});
 assert.deepEqual(validateEmail('a'.repeat(255),'contact'),{ok:false,reason:'TOO_LONG'});
});

test('HTTP text adapter preserves safe field errors and malformed-type status',()=>{
 assert.equal(textField(' Name ','/displayName',200,true),'Name');assert.equal(textField(' ','/address',500),null);
 assert.throws(()=>textField(12,'/displayName',200),e=>e.status===400&&e.code==='INVALID_REQUEST');
 for(const value of ['', 'A\u0000B','😀'.repeat(201)])assert.throws(()=>textField(value,'/displayName',200,true),e=>e.status===422&&e.errors[0].pointer==='/displayName'&&e.errors[0].code==='INVALID_TEXT'&&e.errors[0].message==='Use 1–200 characters.');
});

test('HTTP email adapter keeps account versus contact error precedence and Draft message',()=>{
 assert.equal(emailField(' CONTACT@Example.test ','/email','contact'),'CONTACT@Example.test');assert.equal(emailField(null,'/email','contact'),null);
 assert.equal(emailField(' STAFF@EXAMPLE.TEST ','/email','account'),'staff@example.test');
 for(const value of ['A\ud800B@example.test','A\u0000B@example.test','a'.repeat(255)]){
  assert.throws(()=>emailField(value,'/email','account'),e=>e.status===422&&e.errors[0].code==='INVALID_EMAIL'&&e.errors[0].message==='Use a valid email address.');
  assert.throws(()=>emailField(value,'/customer/email','contact'),e=>e.status===422&&e.errors[0].pointer==='/customer/email'&&e.errors[0].code==='INVALID_TEXT'&&e.errors[0].message==='Use 0–254 characters.');
 }
 assert.throws(()=>emailField('bad','/customer/email','contact','Supply a valid value within the documented limits.'),e=>e.errors[0].code==='INVALID_EMAIL'&&e.errors[0].message==='Supply a valid value within the documented limits.');
 assert.throws(()=>emailField(42,'/email','account'),e=>e.status===400);
});

test('invalid login email uses dummy verification without identity lookup or unexpected exceptions',async()=>{
 const passwords=new PasswordService(),original=passwords.dummyVerify.bind(passwords);let dummy=0;
 passwords.dummyVerify=async value=>{dummy++;await original(value);};
 const repository={database:{client:{staffUser:{findUnique:async()=>{throw Error('Invalid email reached identity lookup');}}}}};
 const service=new AuthService(fixtureConfig(),repository,passwords,{},{});
 const inputs=['a\ud800b@example.test','a@\udfff.test','a\u0000b@example.test','bad',null,undefined];
 for(const email of inputs)await assert.rejects(()=>service.login({email,password}),e=>e.status===401&&e.code==='INVALID_CREDENTIALS');
 assert.equal(dummy,inputs.length);
});
