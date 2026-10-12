import {randomUUID} from 'node:crypto';
import type {AppConfig} from '../../config/env.js';
import {Prisma,type Quotation,type QuotationVersion,type ViewingAccess} from '../../generated/prisma/client.js';
import {HttpProblem} from '../../http/problem.js';
import {AuthRepository} from '../auth/auth.repository.js';
import {requireId,type WriteHeaders} from '../common/common-data.js';
import {QuotationMapper,quotationETag} from './quotations.mapper.js';
import {QuotationsRepository} from './quotations.repository.js';
import {QuotationsService} from './quotations.service.js';
import {PublicationDocument} from './publication-document.js';
import {ReviewTokens,ViewingTokens,accessETag,type ReviewBinding} from './publication-security.js';

export class PublicationService {
  private readonly document:PublicationDocument;
  private readonly reviews:ReviewTokens;
  private readonly tokens:ViewingTokens;
  constructor(private readonly config:AppConfig,private readonly auth:AuthRepository,private readonly repository:QuotationsRepository,private readonly mutations:QuotationsService){
    this.document=new PublicationDocument(new QuotationMapper(config.recoveryEpoch));this.reviews=new ReviewTokens(config.reviewKey);this.tokens=new ViewingTokens(config);
  }
  private tag(value:string|undefined):string{if(!value||!/^"[^"\r\n]+"$/.test(value))throw new HttpProblem(428,'PRECONDITION_REQUIRED');return value;}
  private draft(version:QuotationVersion,tag:string|undefined):void {
    if(this.tag(tag)!==quotationETag('version',version.id,version.revision,this.config.recoveryEpoch))throw new HttpProblem(412,'REVISION_CONFLICT');
    if(version.state!=='DRAFT')throw new HttpProblem(409,'VERSION_IMMUTABLE');
  }
  private binding(actorId:string,q:Quotation,v:QuotationVersion,companyRevision:number,presentationHash:string):ReviewBinding {
    return {actorId,quotationId:q.id,versionId:v.id,quotationRevision:q.revision,versionRevision:v.revision,companyRevision,recoveryEpoch:this.config.recoveryEpoch,presentationHash};
  }
  revision(token:string|undefined,csrf:string|undefined,q:string,headers:WriteHeaders){
    q=requireId(q);return this.mutations.write(token,csrf,headers,'CREATE_REVISION','POST',`/api/v1/quotations/${q}/revisions`,{},async context=>{
      const tag=this.tag(headers.precondition),quote=await this.repository.quotation(context,q,true),existing=await context.tx.quotationVersion.findFirst({where:{quotationId:q,state:'DRAFT'}});
      if(existing)return {kind:'REUSE_DRAFT',resourceIds:{quotationId:q,versionId:existing.id},appliedRevisions:{quotation:quote.revision,version:existing.revision}};
      if(tag!==quotationETag('quotation',q,quote.revision,this.config.recoveryEpoch))throw new HttpProblem(412,'REVISION_CONFLICT');
      if(!quote.latestSharedVersionId)throw new HttpProblem(404,'NOT_FOUND');
      const latest=await this.repository.version(context.tx,q,quote.latestSharedVersionId),content=this.document.draft(latest),now=await this.auth.clock(context.tx);
      if(latest.state!=='SHARED'||quote.lastAllocatedNumber>=2147483647)throw new HttpProblem(503,'SERVICE_UNAVAILABLE');
      const version=await context.tx.quotationVersion.create({data:{quotationId:q,number:quote.lastAllocatedNumber+1,content:content as unknown as Prisma.InputJsonObject,createdAt:now,updatedAt:now}});
      const updated=await context.tx.quotation.update({where:{id:q},data:{lastAllocatedNumber:{increment:1},revision:{increment:1},updatedAt:now,summaryCustomerName:content.customer.name,summaryWorkDescription:content.work.description,summaryTotalVnd:content.calculation.total===null?null:BigInt(content.calculation.total)}});
      return {resourceIds:{quotationId:q,versionId:version.id},appliedRevisions:{quotation:updated.revision,version:version.revision}};
    });
  }
  review(token:string|undefined,q:string,v:string,tag:string|undefined){
    q=requireId(q);v=requireId(v);return this.auth.withSession(token,{allowLimited:false},async context=>{
      const company=await this.repository.company(context.tx),quote=await this.repository.quotation(context,q),version=await this.repository.version(context.tx,q,v);this.draft(version,tag);
      const content=this.document.recalculate(version);this.document.ready(quote,version,company,content);
      const presentation=this.document.public(quote,version,content,this.document.company(company),null),now=await this.auth.clock(context.tx);
      return {draftETag:quotationETag('version',v,version.revision,this.config.recoveryEpoch),reviewToken:this.reviews.issue(this.binding(context.staff.id,quote,version,company.revision,this.document.hash(presentation)),now),presentation};
    });
  }
  share(token:string|undefined,csrf:string|undefined,q:string,v:string,reviewToken:string,headers:WriteHeaders){
    q=requireId(q);v=requireId(v);return this.mutations.write(token,csrf,headers,'SHARE_QUOTATION','POST',`/api/v1/quotations/${q}/versions/${v}/share`,{reviewToken},async context=>{
      const company=await this.repository.company(context.tx),quote=await this.repository.quotation(context,q,true),version=await this.repository.version(context.tx,q,v,true);this.draft(version,headers.precondition);
      const previous=await this.repository.access(context.tx,q,true),now=await this.auth.clock(context.tx),reviewed=this.reviews.read(reviewToken,now);
      this.reviews.verify(reviewToken,this.binding(context.staff.id,quote,version,company.revision,reviewed.presentationHash),now);
      const content=this.document.recalculate(version);this.document.ready(quote,version,company,content);
      const companySnapshot=this.document.company(company),presentation=this.document.public(quote,version,content,companySnapshot,null);
      this.reviews.verify(reviewToken,this.binding(context.staff.id,quote,version,company.revision,this.document.hash(presentation)),now);
      const generation=randomUUID(),encrypted=this.tokens.issue(q,v,generation);
      const updated=await context.tx.quotationVersion.update({where:{id:v},data:{state:'SHARED',sharedAt:now,updatedAt:now,revision:{increment:1},content:{...content,companySnapshot} as unknown as Prisma.InputJsonObject}});
      const quotation=await context.tx.quotation.update({where:{id:q},data:{latestSharedVersionId:v,revision:{increment:1},updatedAt:now,summaryCustomerName:content.customer.name,summaryWorkDescription:content.work.description,summaryTotalVnd:BigInt(content.calculation.total!)}});
      const data={versionId:v,generation,...encrypted,issuedAt:now,expiresAt:new Date(now.getTime()+720*3600000),revokedAt:null,revision:(previous?.revision??0)+1};
      const access=await context.tx.viewingAccess.upsert({where:{quotationId:q},create:{quotationId:q,...data},update:data});
      return {resourceIds:{quotationId:q,versionId:v},appliedRevisions:{quotation:quotation.revision,version:updated.revision,access:access.revision},accessGeneration:generation};
    });
  }
  private latest(quote:Quotation,version:QuotationVersion,row:ViewingAccess|null):ViewingAccess {
    if(version.state!=='SHARED')throw new HttpProblem(404,'NOT_FOUND');
    if(quote.latestSharedVersionId!==version.id||row?.versionId!==version.id)throw new HttpProblem(409,'ACCESS_SUPERSEDED');return row;
  }
  private status(row:ViewingAccess,now:Date){return row.revokedAt?'REVOKED' as const:now>=row.expiresAt?'EXPIRED' as const:'ACTIVE' as const;}
  access(token:string|undefined,q:string,v:string){
    q=requireId(q);v=requireId(v);return this.auth.withSession(token,{allowLimited:false},async context=>{
      const quote=await this.repository.quotation(context,q),version=await this.repository.version(context.tx,q,v),row=await this.repository.access(context.tx,q);
      if(version.state!=='SHARED')throw new HttpProblem(404,'NOT_FOUND');
      if(quote.latestSharedVersionId!==v)return {status:'SUPERSEDED' as const};
      const current=this.latest(quote,version,row),now=await this.auth.clock(context.tx);
      return {status:this.status(current,now),generation:current.generation,issuedAt:current.issuedAt.toISOString(),expiresAt:current.expiresAt.toISOString(),revokedAt:current.revokedAt?.toISOString()??null,etag:accessETag(current,current.revision,this.config.recoveryEpoch)};
    });
  }
  link(token:string|undefined,q:string,v:string,tag:string|undefined){
    q=requireId(q);v=requireId(v);return this.auth.withSession(token,{allowLimited:false},async context=>{
      const quote=await this.repository.quotation(context,q),version=await this.repository.version(context.tx,q,v),row=this.latest(quote,version,await this.repository.access(context.tx,q));
      if(this.tag(tag)!==accessETag(row,row.revision,this.config.recoveryEpoch))throw new HttpProblem(412,'REVISION_CONFLICT');
      if(this.status(row,await this.auth.clock(context.tx))!=='ACTIVE')throw new HttpProblem(404,'LINK_UNAVAILABLE');
      return {url:this.config.userOrigin+'/q#'+this.tokens.recover(row),generation:row.generation,expiresAt:row.expiresAt.toISOString()};
    });
  }
  changeAccess(token:string|undefined,csrf:string|undefined,q:string,v:string,replace:boolean,headers:WriteHeaders){
    q=requireId(q);v=requireId(v);const action=replace?'replace':'revoke';return this.mutations.write(token,csrf,headers,replace?'REPLACE_ACCESS':'REVOKE_ACCESS','POST',`/api/v1/quotations/${q}/versions/${v}/access/${action}`,{},async context=>{
      const quote=await this.repository.quotation(context,q,true),version=await this.repository.version(context.tx,q,v),row=this.latest(quote,version,await this.repository.access(context.tx,q,true));
      if(this.tag(headers.precondition)!==accessETag(row,row.revision,this.config.recoveryEpoch))throw new HttpProblem(412,'REVISION_CONFLICT');
      const now=await this.auth.clock(context.tx),generation=replace?randomUUID():row.generation;
      const data=replace?{generation,...this.tokens.issue(q,v,generation),issuedAt:now,expiresAt:new Date(now.getTime()+720*3600000),revokedAt:null,revision:{increment:1}}:{revokedAt:row.revokedAt??now,tokenCiphertext:null,tokenNonce:null,tokenTag:null,encryptionKeyId:null,revision:{increment:1}};
      const updated=await context.tx.viewingAccess.update({where:{quotationId:q},data});
      return {resourceIds:{quotationId:q,versionId:v},appliedRevisions:{access:updated.revision},accessGeneration:generation};
    });
  }
}
