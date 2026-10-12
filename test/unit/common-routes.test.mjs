import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import {createApp} from '../../dist/app.js';
import {Database} from '../../dist/database/prisma.js';
import {fixtureConfig} from '../helpers.mjs';

test('common-data endpoints require a staff session before accessing the database', async () => {
  const config=fixtureConfig(), db=new Database(config.databaseUrl);
  try {
    const app=createApp(config,db);
    for(const path of ['/api/v1/company','/api/v1/catalog-items','/api/v1/catalog-items/30000000-0000-4000-8000-000000000001']) {
      const response=await request(app).get(path);
      assert.equal(response.status,401,path);
      assert.equal(response.body.code,'SESSION_REQUIRED');
    }
  } finally { await db.close(); }
});
