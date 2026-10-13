import {createHmac} from "node:crypto";
import {isUUID} from "class-validator";
import type {AppConfig} from "../../config/env.js";
import {Prisma} from "../../generated/prisma/client.js";
import {HttpProblem} from "../../http/problem.js";
import {AuthRepository,type SessionContext} from "../auth/auth.repository.js";
import {operationSummary} from "../auth/auth.mapper.js";
import {OperationReceiptService} from "../auth/operation-receipt.service.js";
import {SessionService,equalBytes,tokenBytes} from "../auth/security.js";
import {requireId,type WriteHeaders} from "../common/common-data.js";
import {validateText} from "../../domain/text.js";
import {DraftDocument} from "./draft-document.js";
import {QuotationMapper,quotationETag} from "./quotations.mapper.js";
import {QuotationsRepository,type ListFilter} from "./quotations.repository.js";
import {QuotationListDto,VersionListDto,RefreshPreviewDto} from "./quotations.dto.js";
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)])):value;
export class QuotationsService {
  private readonly mapper:QuotationMapper;private readonly document=new DraftDocument();private readonly receipts:OperationReceiptService;
  constructor(private readonly config:AppConfig,private readonly auth:AuthRepository,private readonly security:SessionService,private readonly repository:QuotationsRepository){this.mapper=new QuotationMapper(config.recoveryEpoch);this.receipts=new OperationReceiptService(config);}
  authorize(token:string|undefined){return this.auth.withSession(token,{allowLimited:false},async()=>{});}
  private precondition(value:string|undefined){if(!value||!/^"[^"\r\n]+"$/.test(value))throw new HttpProblem(428,"PRECONDITION_REQUIRED");return value;}
  private currentVersion(row:{id:string;revision:number;state:string},tag:string){if(tag!==quotationETag('version',row.id,row.revision,this.config.recoveryEpoch))throw new HttpProblem(412,'REVISION_CONFLICT');if(row.state!=='DRAFT')throw new HttpProblem(409,'VERSION_IMMUTABLE');}
  private fingerprint(keyId:string,method:string,path:string,body:unknown,precondition:string){const key=this.config.operationKeys.get(keyId);if(!key)throw new HttpProblem(503,'SERVICE_UNAVAILABLE');return createHmac('sha256',key).update(JSON.stringify([this.config.recoveryEpoch,method,path,canonical(body),precondition])).digest();}
  write(token:string|undefined,csrf:string|undefined,headers:WriteHeaders,kind:string,method:string,path:string,body:unknown,apply:(context:SessionContext)=>Promise<{resourceIds:Prisma.InputJsonObject;appliedRevisions:Prisma.InputJsonObject;accessGeneration?:string;kind?:'REUSE_DRAFT'}>){
    return this.auth.withSession(token,{allowLimited:false,exclusiveStaff:true},async context=>{
      if(!this.security.validCsrf(context.token,csrf))throw new HttpProblem(403,'FORBIDDEN');this.receipts.requireEpoch(headers.epoch);if(!headers.key||!isUUID(headers.key))throw new HttpProblem(400,'IDEMPOTENCY_KEY_REQUIRED');const tag=method==='POST'?headers.precondition??'':this.precondition(headers.precondition);
      const existing=await this.receipts.existing(context,headers.key);
      if(existing){if((existing.kind!==kind&&!(kind==='CREATE_REVISION'&&existing.kind==='REUSE_DRAFT'))||!equalBytes(existing.fingerprint,this.fingerprint(existing.fingerprintKeyId,method,path,body,tag)))throw new HttpProblem(409,'IDEMPOTENCY_KEY_REUSED');const target=existing.target as {quotationId?:unknown};if(typeof target.quotationId!=='string'||!isUUID(target.quotationId))throw new HttpProblem(404,'OPERATION_UNKNOWN');await this.repository.quotation(context,target.quotationId,true,true);return {operation:operationSummary(existing)};}
      const applied=await apply(context);context.now=await this.auth.clock(context.tx);
      const receipt=await context.tx.operationReceipt.create({data:{actorId:context.staff.id,idempotencyKey:headers.key,recoveryEpoch:this.config.recoveryEpoch,kind,method,route:path,fingerprint:new Uint8Array(this.fingerprint(this.config.operationKeyId,method,path,body,tag)),fingerprintKeyId:this.config.operationKeyId,target:applied.resourceIds,...applied,committedAt:context.now}});return {operation:operationSummary(receipt)};
    });
  }
  create(token:string|undefined,csrf:string|undefined,headers:WriteHeaders){return this.write(token,csrf,headers,'CREATE_QUOTATION','POST','/api/v1/quotations',{},async context=>{
    const now=await this.auth.clock(context.tx),q=await context.tx.quotation.create({data:{ownerId:context.staff.id,createdAt:now,updatedAt:now}}),v=await context.tx.quotationVersion.create({data:{quotationId:q.id,number:1,content:DraftDocument.empty() as unknown as Prisma.InputJsonObject,createdAt:now,updatedAt:now}});return {resourceIds:{quotationId:q.id,versionId:v.id},appliedRevisions:{quotation:1,version:1}};
  });}
  read(token:string|undefined,id:string){id=requireId(id);return this.auth.withSession(token,{allowLimited:false},async context=>this.mapper.summary(await this.repository.summary(context,await this.repository.quotation(context,id))));}
  version(token:string|undefined,q:string,v:string){q=requireId(q);v=requireId(v);return this.auth.withSession(token,{allowLimited:false},async context=>{
    const company=await this.repository.company(context.tx),quote=await this.repository.quotation(context,q),version=await this.repository.version(context.tx,q,v);return this.mapper.read(quote,version,company);
  });}
  save(token:string|undefined,csrf:string|undefined,q:string,v:string,body:unknown,headers:WriteHeaders){q=requireId(q);v=requireId(v);return this.write(token,csrf,headers,'SAVE_DRAFT','PUT',`/api/v1/quotations/${q}/versions/${v}/draft`,body,async context=>{
    await this.repository.quotation(context,q,true);const version=await this.repository.version(context.tx,q,v,true);this.currentVersion(version,this.precondition(headers.precondition));const saved=this.mapper.content(version.content),sources=await this.repository.sources(context.tx,this.document.sources(body,saved.lines)),content=this.document.resolve(body,saved.lines,sources),now=await this.auth.clock(context.tx);
    const updated=await context.tx.quotationVersion.update({where:{id:v},data:{content:content as unknown as Prisma.InputJsonObject,revision:{increment:1},updatedAt:now}}),quote=await context.tx.quotation.update({where:{id:q},data:{summaryCustomerName:content.customer.name,summaryWorkDescription:content.work.description,summaryTotalVnd:content.calculation.total===null?null:BigInt(content.calculation.total),revision:{increment:1},updatedAt:now}});return {resourceIds:{quotationId:q,versionId:v},appliedRevisions:{quotation:quote.revision,version:updated.revision}};
  });}
  discard(token:string|undefined,csrf:string|undefined,q:string,v:string,headers:WriteHeaders){q=requireId(q);v=requireId(v);return this.write(token,csrf,headers,'DISCARD_DRAFT','DELETE',`/api/v1/quotations/${q}/versions/${v}/draft`,null,async context=>{
    const quote=await this.repository.quotation(context,q,true),version=await this.repository.version(context.tx,q,v,true);this.currentVersion(version,this.precondition(headers.precondition));await context.tx.quotationVersion.delete({where:{id:v}});const now=await this.auth.clock(context.tx);
    let customerName:string|null=null,workDescription:string|null=null,total:string|null=null;
    if(quote.latestSharedVersionId){const latest=await this.repository.version(context.tx,q,quote.latestSharedVersionId),content=this.mapper.content(latest.content);customerName=content.customer.name;workDescription=content.work.description;total=content.calculation.total;}
    const updated=await context.tx.quotation.update({where:{id:q},data:{discardedAt:quote.latestSharedVersionId?null:now,summaryCustomerName:customerName,summaryWorkDescription:workDescription,summaryTotalVnd:total===null?null:BigInt(total),revision:{increment:1},updatedAt:now}});return {resourceIds:{quotationId:q,versionId:v},appliedRevisions:{quotation:updated.revision}};
  });}
  preview(token:string|undefined,q:string,v:string,body:unknown,tag:string|undefined){q=requireId(q);v=requireId(v);return this.auth.withSession(token,{allowLimited:false},async context=>{
    const company=await this.repository.company(context.tx),quote=await this.repository.quotation(context,q),version=await this.repository.version(context.tx,q,v);this.currentVersion(version,this.precondition(tag));const saved=this.mapper.content(version.content),sources=await this.repository.sources(context.tx,this.document.sources(body,saved.lines)),content=this.document.resolve(body,saved.lines,sources);return this.mapper.read(quote,version,company,content,false);
  });}
  refresh(token:string|undefined,q:string,v:string,lineId:string,body:RefreshPreviewDto,tag:string|undefined){q=requireId(q);v=requireId(v);lineId=requireId(lineId);return this.auth.withSession(token,{allowLimited:false},async context=>{
    await this.repository.quotation(context,q);const version=await this.repository.version(context.tx,q,v);this.currentVersion(version,this.precondition(tag));const line=this.mapper.content(version.content).lines.find(line=>line.lineId===lineId);if(!line)throw new HttpProblem(404,'NOT_FOUND');if(line.kind!=='CATALOG')throw new HttpProblem(409,'SOURCE_UNAVAILABLE');
    const source=(await this.repository.sources(context.tx,[line.sourceCatalogId!])).get(line.sourceCatalogId!);if(!source?.active)throw new HttpProblem(409,'SOURCE_UNAVAILABLE');if(source.unit!==line.unit)throw new HttpProblem(409,'UNIT_MISMATCH');const quantity=this.document.number(body.quantity,'/quantity',true),override=this.document.number(body.overrideUnitPrice,'/overrideUnitPrice'),newBase=source.unitPriceVnd.toString();
    const calculate=(price:string)=>this.document.resolve({customer:{name:null,contactPerson:null,phone:null,email:null,address:null},work:{description:null,siteAddress:null},terms:null,lines:[{lineId,kind:'CUSTOM',description:null,unit:null,quantity,unitPrice:price}]},[],new Map()).lines[0]!.amount;
    return {persisted:false,lineId,sourceRevision:source.revision,oldBaseUnitPrice:line.baseUnitPrice,newBaseUnitPrice:newBase,oldUnitPrice:override??line.baseUnitPrice,newUnitPrice:override??newBase,overrideRetained:override!==null,oldAmount:calculate(override??line.baseUnitPrice!),newAmount:calculate(override??newBase)};
  });}
  private cursor(kind:string,filters:unknown,position:unknown){const payload=Buffer.from(JSON.stringify([this.config.operationKeyId,this.config.recoveryEpoch,kind,filters,position])).toString('base64url');return payload+'.'+createHmac('sha256',this.config.operationKeys.get(this.config.operationKeyId)!).update('quotation-cursor:'+payload).digest('base64url');}
  private position(cursor:unknown,kind:string,filters:unknown):unknown {
    try{if(typeof cursor!=='string'||cursor.length>4096||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor))throw Error();const [payload,signature]=cursor.split('.') as [string,string],value=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));if(!Array.isArray(value)||value.length!==5||value[1]!==this.config.recoveryEpoch||value[2]!==kind||JSON.stringify(value[3])!==JSON.stringify(filters))throw Error();const key=this.config.operationKeys.get(value[0]);if(!key||!equalBytes(tokenBytes(signature),createHmac('sha256',key).update('quotation-cursor:'+payload).digest()))throw Error();return value[4];}catch{throw new HttpProblem(400,'INVALID_REQUEST');}
  }
  private limit(value:unknown){if(value===undefined)return 25;if(typeof value!=='string'||!/^[1-9]\d*$/.test(value)||Number(value)>100)throw new HttpProblem(400,'INVALID_REQUEST');return Number(value);}
  list(token:string|undefined,dto:QuotationListDto){return this.auth.withSession(token,{allowLimited:false},async context=>{
    const query=dto.query,limit=this.limit(query.limit);if(query.search!==undefined&&typeof query.search!=='string')throw new HttpProblem(400,'INVALID_REQUEST');const parsed=validateText(query.search??'',{maxCodePoints:200});if(!parsed.ok)throw new HttpProblem(400,'INVALID_REQUEST');const search=parsed.value??'';const filter:ListFilter={limit,search};for(const name of ['hasDraft','hasShared'] as const)if(query[name]!==undefined){if(!['true','false'].includes(query[name] as string))throw new HttpProblem(400,'INVALID_REQUEST');filter[name]=query[name]==='true';}
    if(query.ownerId!==undefined){if(context.staff.role!=='ADMINISTRATOR')throw new HttpProblem(403,'FORBIDDEN');if(typeof query.ownerId!=='string')throw new HttpProblem(400,'INVALID_REQUEST');filter.ownerId=requireId(query.ownerId);}
    const filters=[search,filter.hasDraft??null,filter.hasShared??null,filter.ownerId??null,limit];if(query.cursor!==undefined){const value=this.position(query.cursor,'list',filters);if(!Array.isArray(value)||value.length!==2||typeof value[0]!=='string'||!Number.isFinite(Date.parse(value[0]))||new Date(value[0]).toISOString()!==value[0]||typeof value[1]!=='string'||!isUUID(value[1]))throw new HttpProblem(400,'INVALID_REQUEST');filter.after=value as [string,string];}
    const rows=await this.repository.list(context,filter),items=rows.slice(0,limit),last=items.at(-1);return {items:items.map(row=>this.mapper.summary(row)),nextCursor:rows.length>limit&&last?this.cursor('list',filters,[last.updatedAt.toISOString(),last.id]):null};
  });}
  history(token:string|undefined,q:string,dto:VersionListDto){q=requireId(q);return this.auth.withSession(token,{allowLimited:false},async context=>{
    await this.repository.quotation(context,q);const limit=this.limit(dto.query.limit),filters=[q,limit];let after=0;if(dto.query.cursor!==undefined){const value=this.position(dto.query.cursor,'versions',filters);if(!Number.isSafeInteger(value)||Number(value)<1)throw new HttpProblem(400,'INVALID_REQUEST');after=Number(value);}
    const rows=await context.tx.quotationVersion.findMany({where:{quotationId:q,number:{gt:after}},orderBy:{number:'asc'},take:limit+1}),items=rows.slice(0,limit),last=items.at(-1);return {items:items.map(row=>this.mapper.metadata(row)),nextCursor:rows.length>limit&&last?this.cursor('versions',filters,last.number):null};
  });}
}
