import { parseConfig } from '../dist/config/env.js';

export const epoch='71000000-0000-4000-8000-000000000001';
export const origin='https://admin.example.test';
export const password='A synthetic horse battery 123!';
export const nextPassword='A different synthetic battery 456!';
export const key=()=>crypto.randomUUID();
export const testUrl=process.env.TEST_DATABASE_URL;
export function fixtureConfig() {
  return parseConfig({DATABASE_URL:testUrl ?? 'postgresql://synthetic:placeholder@127.0.0.1:1/auth_test',
    ADMIN_ORIGIN:origin,USER_ORIGIN:'https://quote.example.test',RECOVERY_EPOCH:epoch,
    CSRF_HMAC_KEY:Buffer.alloc(32,1).toString('base64'),RATE_LIMIT_HMAC_KEY:Buffer.alloc(32,2).toString('base64'),
    REVIEW_HMAC_KEY:Buffer.alloc(32,3).toString('base64'),
    OPERATION_HMAC_KEYS:JSON.stringify({v1:Buffer.alloc(32,4).toString('base64')}),OPERATION_HMAC_CURRENT_KEY_ID:'v1',
    VIEWING_LINK_KEYS:JSON.stringify({v1:Buffer.alloc(32,5).toString('base64')}),VIEWING_LINK_CURRENT_KEY_ID:'v1'});
}
