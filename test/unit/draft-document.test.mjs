import assert from 'node:assert/strict';
import test from 'node:test';
import {DraftDocument} from '../../dist/modules/quotations/draft-document.js';
const id='40000000-0000-4000-8000-000000000001';
const base=()=>({customer:{name:null,contactPerson:null,phone:null,email:null,address:null},work:{description:null,siteAddress:null},terms:null,lines:[]});
test('draft document accepts complete replacement and normalizes text and exact custom calculation',()=>{
 const body=base();body.customer.name=' Customer ';body.work.description=' Work ';body.lines=[{lineId:id,kind:'CUSTOM',description:' Task ',unit:' m ',quantity:'00.500',unitPrice:'00101'}];
 const doc=new DraftDocument().resolve(body,[],new Map());
 assert.equal(doc.customer.name,'Customer');assert.equal(doc.lines[0].amount,'51');assert.equal(doc.calculation.total,'51');assert.equal(doc.lines[0].quantity,'0.5');
});
test('draft document rejects untrusted fields, duplicate IDs, missing fields and numeric JSON',()=>{
 for(const body of [{...base(),ownerId:id},{...base(),terms:undefined},{...base(),customer:{name:null}},{...base(),lines:[{lineId:id,kind:'CUSTOM',description:null,unit:null,quantity:1,unitPrice:'2'}]},{...base(),lines:[{lineId:id,kind:'CUSTOM',description:null,unit:null,quantity:null,unitPrice:null},{lineId:id,kind:'CUSTOM',description:null,unit:null,quantity:null,unitPrice:null}]}])assert.throws(()=>new DraftDocument().resolve(body,[],new Map()));
});
test('copied catalog provenance stays trusted, inactive saved sources retain bases, refresh keeps override',()=>{
 const catalogId='30000000-0000-4000-8000-000000000001';
 const sources=new Map([[catalogId,{id:catalogId,active:true,revision:1,unit:'m',unitPriceVnd:100n}]]);
 const body=base();body.lines=[{lineId:id,kind:'CATALOG',sourceCatalogId:catalogId,sourceRevision:1,description:null,quantity:'1',overrideUnitPrice:'90'}];
 const saved=new DraftDocument().resolve(body,[],sources);
 const next={...base(),lines:[{lineId:id,kind:'CATALOG',description:'Changed',quantity:'2',overrideUnitPrice:null}]};
 assert.equal(new DraftDocument().resolve(next,saved.lines,new Map()).lines[0].unitPrice,'100');
 sources.set(catalogId,{id:catalogId,active:true,revision:2,unit:'m',unitPriceVnd:120n});next.lines[0].overrideUnitPrice='90';next.lines[0].refreshSourceRevision=2;
 const refreshed=new DraftDocument().resolve(next,saved.lines,sources);assert.equal(refreshed.lines[0].baseUnitPrice,'120');assert.equal(refreshed.lines[0].unitPrice,'90');assert.equal(refreshed.lines[0].amount,'180');
 next.lines[0].sourceCatalogId=catalogId;assert.throws(()=>new DraftDocument().resolve(next,saved.lines,sources));
});
test('line kind must be a string enum and rejects coercible arrays and malformed objects safely',()=>{
 const catalogId='30000000-0000-4000-8000-000000000001',source={id:catalogId,active:true,revision:1,unit:'m',unitPriceVnd:100n};
 for(const kind of [['CATALOG'],{toString:null},['CUSTOM']]){
   const body={...base(),lines:[{lineId:id,kind,description:null,quantity:'1',sourceCatalogId:catalogId,sourceRevision:1,overrideUnitPrice:null}]};
   assert.throws(()=>new DraftDocument().resolve(body,[],new Map([[catalogId,source]])),error=>error.status===400);
 }
});
