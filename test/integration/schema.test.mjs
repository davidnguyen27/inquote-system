import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import request from 'supertest';
import {Database} from '../../dist/database/prisma.js';
import {createApp} from '../../dist/app.js';
import {PasswordService} from '../../dist/modules/auth/password.service.js';
import {fixtureConfig,testUrl,origin,password,nextPassword,epoch,key} from '../helpers.mjs';
if(!testUrl||!new URL(testUrl).pathname.endsWith('_test'))throw new Error('A dedicated TEST_DATABASE_URL ending in _test is required.');

test('URL schema governs ORM, raw locks/counters and operator writes despite a conflicting search_path',async()=>{
  const control=new pg.Client({connectionString:testUrl});await control.connect();
  const schema='auth schema-test';const quoted='"'+schema+'"';
  const url=new URL(testUrl);url.searchParams.set('schema',schema);url.searchParams.set('options','-c search_path=public -c timezone=Asia/Bangkok');
  const db=new Database(url.toString());
  try{
    await control.query('CREATE SCHEMA '+quoted);await control.query('SET search_path='+quoted+',pg_catalog');
    await control.query(readFileSync(new URL('../../prisma/migrations/20261010000000_initial/migration.sql',import.meta.url),'utf8'));
    const before=await control.query('SELECT count(*) FROM public.staff_user');
    const hash=await new PasswordService().hash(password);
    await control.query('INSERT INTO staff_user (display_name,normalized_email,password_hash) VALUES ($1,$2,$3)',['Synthetic schema staff','schema@example.test',hash]);
    const app=createApp({...fixtureConfig(),databaseUrl:url.toString()},db);
    const s=await request(app).post('/api/v1/auth/login').set('Origin',origin).send({email:'schema@example.test',password});assert.equal(s.status,200);
    const cookie=s.headers['set-cookie'][0].split(';')[0];
    const change=await request(app).post('/api/v1/auth/change-password').set('Origin',origin).set('Cookie',cookie).set('X-CSRF-Token',s.body.csrfToken).set('If-Match',s.body.staffETag).set('Idempotency-Key',key()).set('X-Recovery-Epoch',epoch).send({currentPassword:password,newPassword:nextPassword});assert.equal(change.status,200);
    assert.equal((await control.query('SELECT count(*) FROM operation_receipt')).rows[0].count,'1');
    assert.ok(Number((await control.query('SELECT count(*) FROM rate_limit_bucket')).rows[0].count)>0);
    const {AdministratorProvisioningService}=await import('../../dist/modules/auth/provisioning.service.js');
    await new AdministratorProvisioningService(db,new PasswordService()).bootstrap('schema-admin@example.test','Schema Admin',password);
    assert.equal((await control.query('SELECT count(*) FROM public.staff_user')).rows[0].count,before.rows[0].count);
    assert.ok(Math.abs((await db.client.$queryRaw`SELECT clock_timestamp() AS now`)[0].now.getTime()-Date.now())<5000);
  }finally{
    await db.close();await control.query('SET search_path=public');await control.query('DROP SCHEMA IF EXISTS '+quoted+' CASCADE');await control.end();
  }
});
