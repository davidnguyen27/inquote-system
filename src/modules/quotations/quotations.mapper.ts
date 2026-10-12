import {createHash} from "node:crypto";
import type {CompanyProfile,Quotation,QuotationVersion,Prisma} from "../../generated/prisma/client.js";
import {HttpProblem} from "../../http/problem.js";
import {CompanyMapper} from "../company/company.mapper.js";
import type {Content,SavedLine} from "./draft-document.js";
import type {SummaryRow} from "./quotations.repository.js";
export function quotationETag(kind:"quotation"|"version",id:string,revision:number,epoch:string){return '"'+createHash('sha256').update(JSON.stringify([epoch,kind,id,revision])).digest('base64url')+'"';}
export class QuotationMapper {
  constructor(private readonly epoch:string){}
  content(value:Prisma.JsonValue):Content {
    const content=value as unknown as Content;
    if(!content||content.currency!=="VND"||!content.customer||!content.work||!Array.isArray(content.lines)||!content.calculation)throw new HttpProblem(503,"SERVICE_UNAVAILABLE");
    return content;
  }
  summary(row:SummaryRow){return {...row,etag:quotationETag("quotation",row.id,row.revision,this.epoch),currency:"VND",summarySource:row.draftVersionId?"DRAFT":"SHARED",createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString()};}
  metadata(row:QuotationVersion){return {id:row.id,quotationId:row.quotationId,number:row.number,state:row.state,revision:row.revision,schemaVersion:row.schemaVersion,etag:quotationETag("version",row.id,row.revision,this.epoch),createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString(),sharedAt:row.sharedAt?.toISOString()??null};}
  read(q:Quotation,v:QuotationVersion,profile:CompanyProfile,content=this.content(v.content),persisted=true){
    if(v.schemaVersion!==1)throw new HttpProblem(503,"SERVICE_UNAVAILABLE");
    const companyContext=new CompanyMapper(this.epoch).read(profile);
    const lines=content.lines.map((line):SavedLine=>({lineId:line.lineId,kind:line.kind,description:line.description,unit:line.unit,quantity:line.quantity,unitPrice:line.unitPrice,amount:line.amount,...(line.kind==="CATALOG"?{sourceCatalogId:line.sourceCatalogId!,sourceRevision:line.sourceRevision!,baseUnitPrice:line.baseUnitPrice!,overrideUnitPrice:line.overrideUnitPrice!}:{})}));
    const missingFields:string[]=[];
    if(!content.customer.name)missingFields.push('/customer/name');if(!content.work.description)missingFields.push('/work/description');if(!companyContext.displayName)missingFields.push('/company/displayName');if(!lines.length)missingFields.push('/lines');
    lines.forEach((line,index)=>{for(const field of ['description','unit','quantity','unitPrice'] as const)if(line[field]===null)missingFields.push(`/lines/${index}/${field}`);});
    const result={...this.metadata(v),reference:q.reference,ownerId:q.ownerId,quotationRevision:q.revision,quotationETag:quotationETag("quotation",q.id,q.revision,this.epoch),currency:"VND",customer:{name:content.customer.name,contactPerson:content.customer.contactPerson,phone:content.customer.phone,email:content.customer.email,address:content.customer.address},work:{description:content.work.description,siteAddress:content.work.siteAddress},terms:content.terms,lines,calculation:{complete:content.calculation.complete,subtotal:content.calculation.subtotal,total:content.calculation.total},persisted};
    if(v.state==='SHARED'){
      const snapshot=(v.content as Prisma.JsonObject).companySnapshot;
      if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))throw new HttpProblem(503,'SERVICE_UNAVAILABLE');
      return {...result,companySnapshot:{displayName:snapshot.displayName,address:snapshot.address,phone:snapshot.phone,email:snapshot.email}};
    }
    return {...result,companyContext,shareReady:content.calculation.complete&&!missingFields.length,missingFields};
  }
}
