import {createHash} from 'node:crypto';
import type {CompanyProfile,Quotation,QuotationVersion,Prisma} from '../../generated/prisma/client.js';
import {VndCalculator} from '../../domain/money.js';
import {HttpProblem} from '../../http/problem.js';
import type {Content} from './draft-document.js';
import {QuotationMapper} from './quotations.mapper.js';

export type CompanySnapshot={displayName:string|null;address:string|null;phone:string|null;email:string|null};
export class PublicationDocument {
  private readonly money=new VndCalculator();
  constructor(private readonly mapper:QuotationMapper){}
  recalculate(version:QuotationVersion):Content {
    if(version.schemaVersion!==1)throw new HttpProblem(503,'SERVICE_UNAVAILABLE');
    const content=this.mapper.content(version.content),calculated=this.money.calculateQuotation(content.lines);
    return {...content,lines:content.lines.map((line,index)=>({...line,...calculated.lines[index]!})),calculation:{complete:calculated.complete,subtotal:calculated.subtotal,total:calculated.total}};
  }
  company(profile:CompanyProfile):CompanySnapshot{return {displayName:profile.displayName,address:profile.address,phone:profile.phone,email:profile.email};}
  ready(q:Quotation,v:QuotationVersion,profile:CompanyProfile,content:Content):void {
    const read=this.mapper.read(q,v,profile,content);
    if(!('shareReady' in read)||!read.shareReady)throw new HttpProblem(422,'VALIDATION_FAILED',('missingFields' in read?read.missingFields:[]).map(pointer=>({pointer,code:'REQUIRED',message:'Complete the saved quotation before sharing.'})));
  }
  public(q:Pick<Quotation,'reference'>,v:Pick<QuotationVersion,'number'>,content:Content,company:CompanySnapshot,sharedAt:string|null){
    if(!content.calculation.complete||content.calculation.total===null||!company.displayName||!content.customer.name||!content.work.description||!content.lines.length||content.lines.some(line=>!line.description||!line.unit||line.quantity===null||line.unitPrice===null||line.amount===null))throw new HttpProblem(503,'SERVICE_UNAVAILABLE');
    return {reference:q.reference,versionNumber:v.number,sharedAt,currency:'VND' as const,company:{displayName:company.displayName,address:company.address,phone:company.phone,email:company.email},customer:{name:content.customer.name},work:{description:content.work.description,siteAddress:content.work.siteAddress},lines:content.lines.map(line=>({description:line.description!,unit:line.unit!,quantity:line.quantity!,unitPrice:line.unitPrice!,amount:line.amount!})),total:content.calculation.total,terms:content.terms};
  }
  snapshot(value:Prisma.JsonValue):CompanySnapshot {
    const snapshot=(value as Prisma.JsonObject)?.companySnapshot;
    if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot)||typeof snapshot.displayName!=='string')throw new HttpProblem(503,'SERVICE_UNAVAILABLE');
    return {displayName:snapshot.displayName,address:snapshot.address as string|null,phone:snapshot.phone as string|null,email:snapshot.email as string|null};
  }
  hash(presentation:ReturnType<PublicationDocument['public']>):string {
    const {sharedAt:_assignedOnPublication,...commercial}=presentation;return createHash('sha256').update(JSON.stringify(commercial)).digest('base64url');
  }
  draft(version:QuotationVersion):Content {
    // Explicit reconstruction drops publication metadata while preserving saved provenance/prices.
    const c=this.mapper.content(version.content);
    return {currency:'VND',customer:{...c.customer},work:{...c.work},terms:c.terms,lines:c.lines.map(line=>({...line})),calculation:{...c.calculation}};
  }
}
