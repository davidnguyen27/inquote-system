import assert from 'node:assert/strict';
import test from 'node:test';
import {ReviewTokens,ViewingTokens,accessETag} from '../../dist/modules/quotations/publication-security.js';
import {fixtureConfig,key} from '../helpers.mjs';
const binding=()=>({actorId:key(),quotationId:key(),versionId:key(),quotationRevision:2,versionRevision:3,companyRevision:1,recoveryEpoch:fixtureConfig().recoveryEpoch,presentationHash:'commercial-hash'});
test('saved review signatures bind every guard and expire at the exact ten-minute boundary',()=>{
 const review=new ReviewTokens(fixtureConfig().reviewKey),b=binding(),now=new Date('2026-10-12T00:00:00Z'),token=review.issue(b,now);
 review.verify(token,b,new Date(now.getTime()+599999));
 assert.throws(()=>review.verify(token,b,new Date(now.getTime()+600000)),e=>e.code==='REVIEW_STALE');
 for(const field of Object.keys(b))assert.throws(()=>review.verify(token,{...b,[field]:typeof b[field]==='number'?b[field]+1:key()},now),e=>e.code==='REVIEW_STALE');
 for(const value of ['',token+'x',[],{},null])assert.throws(()=>review.verify(value,b,now),e=>e.code==='REVIEW_STALE');
});
test('viewing tokens use randomized authenticated encryption bound to the exact grant and retain old keys',()=>{
 const config=fixtureConfig(),tokens=new ViewingTokens(config),q=key(),v=key(),generation=key(),issued=tokens.issue(q,v,generation),row={quotationId:q,versionId:v,generation,...issued};
 const token=tokens.recover(row);assert.match(token,/^[A-Za-z0-9_-]{43}$/);assert.deepEqual(tokens.digest(token),issued.tokenHash);assert.equal(issued.tokenCiphertext.length,32);assert.equal(issued.tokenNonce.length,12);assert.equal(issued.tokenTag.length,16);assert.notDeepEqual(tokens.issue(q,v,generation).tokenHash,issued.tokenHash);
 for(const field of ['quotationId','versionId','generation'])assert.throws(()=>tokens.recover({...row,[field]:key()}),e=>e.code==='SERVICE_UNAVAILABLE');
 const corrupted=new Uint8Array(issued.tokenTag);corrupted[0]^=1;assert.throws(()=>tokens.recover({...row,tokenTag:corrupted}),e=>e.code==='SERVICE_UNAVAILABLE');
 const rotated=new ViewingTokens({...config,viewingKeyId:'v2',viewingKeys:new Map([...config.viewingKeys,['v2',Buffer.alloc(32,8)]])});assert.equal(rotated.recover(row),token);assert.throws(()=>new ViewingTokens({...config,viewingKeys:new Map()}).recover(row),e=>e.code==='SERVICE_UNAVAILABLE');
 assert.notEqual(accessETag(row,1,config.recoveryEpoch),accessETag(row,2,config.recoveryEpoch));assert.notEqual(accessETag(row,1,config.recoveryEpoch),accessETag(row,1,key()));
});
