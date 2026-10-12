import {Prisma,type Quotation,type QuotationVersion} from "../../generated/prisma/client.js";
import type {SessionContext} from "../auth/auth.repository.js";
import {HttpProblem} from "../../http/problem.js";
export type SummaryRow={id:string;reference:string;ownerId:string;lastAllocatedNumber:number;revision:number;createdAt:Date;updatedAt:Date;customerName:string|null;workDescription:string|null;total:string|null;draftVersionId:string|null;draftVersionNumber:number|null;latestSharedVersionId:string|null};
export type ListFilter={limit:number;search:string;hasDraft?:boolean;hasShared?:boolean;ownerId?:string;after?:[string,string]};
export class QuotationsRepository {
  async company(tx:Prisma.TransactionClient){await tx.$queryRaw`SELECT id FROM company_profile WHERE id=1 FOR SHARE`;const row=await tx.companyProfile.findUnique({where:{id:1}});if(!row)throw new HttpProblem(503,"SERVICE_UNAVAILABLE");return row;}
  async quotation(context:SessionContext,id:string,write=false,retained=false):Promise<Quotation>{
    const guard=Prisma.sql`id=${id}::uuid AND (${context.staff.role==="ADMINISTRATOR"} OR owner_id=${context.staff.id}::uuid) AND (${retained} OR discarded_at IS NULL)`;
    const rows=await context.tx.$queryRaw<{id:string}[]>(write?Prisma.sql`SELECT id FROM quotation WHERE ${guard} FOR UPDATE`:Prisma.sql`SELECT id FROM quotation WHERE ${guard} FOR SHARE`);
    if(!rows.length)throw new HttpProblem(404,"NOT_FOUND");return (await context.tx.quotation.findUnique({where:{id}}))!;
  }
  async version(tx:Prisma.TransactionClient,q:string,v:string,write=false):Promise<QuotationVersion>{
    const guard=Prisma.sql`id=${v}::uuid AND quotation_id=${q}::uuid`;
    const rows=await tx.$queryRaw<{id:string}[]>(write?Prisma.sql`SELECT id FROM quotation_version WHERE ${guard} FOR UPDATE`:Prisma.sql`SELECT id FROM quotation_version WHERE ${guard} FOR SHARE`);
    if(!rows.length)throw new HttpProblem(404,"NOT_FOUND");return (await tx.quotationVersion.findUnique({where:{id:v}}))!;
  }
  async sources(tx:Prisma.TransactionClient,ids:string[]){
    if(!ids.length)return new Map();
    await tx.$queryRaw(Prisma.sql`SELECT id FROM catalog_item WHERE id IN (${Prisma.join(ids.map(id=>Prisma.sql`${id}::uuid`))}) ORDER BY id FOR SHARE`);
    return new Map((await tx.catalogItem.findMany({where:{id:{in:ids}}})).map(row=>[row.id,row]));
  }
  async access(tx:Prisma.TransactionClient,q:string,write=false){
    await tx.$queryRaw(write?Prisma.sql`SELECT quotation_id FROM viewing_access WHERE quotation_id=${q}::uuid FOR UPDATE`:Prisma.sql`SELECT quotation_id FROM viewing_access WHERE quotation_id=${q}::uuid FOR SHARE`);
    return tx.viewingAccess.findUnique({where:{quotationId:q}});
  }
  list(context:SessionContext,filter:ListFilter):Promise<SummaryRow[]>{
    const clauses=[Prisma.sql`q.discarded_at IS NULL`];
    if(context.staff.role!=="ADMINISTRATOR")clauses.push(Prisma.sql`q.owner_id=${context.staff.id}::uuid`);
    if(filter.ownerId)clauses.push(Prisma.sql`q.owner_id=${filter.ownerId}::uuid`);
    if(filter.hasDraft!==undefined)clauses.push(Prisma.sql`(d.id IS NOT NULL)=${filter.hasDraft}`);
    if(filter.hasShared!==undefined)clauses.push(Prisma.sql`(q.latest_shared_version_id IS NOT NULL)=${filter.hasShared}`);
    if(filter.search){const search='%'+filter.search.replace(/[\\%_]/g,'\\$&')+'%';clauses.push(Prisma.sql`(q.reference ILIKE ${search} OR q.summary_customer_name ILIKE ${search} OR q.summary_work_description ILIKE ${search})`);}
    if(filter.after)clauses.push(Prisma.sql`(q.updated_at,q.id)<(${filter.after[0]}::timestamptz,${filter.after[1]}::uuid)`);
    return context.tx.$queryRaw<SummaryRow[]>(Prisma.sql`SELECT q.id,q.reference,q.owner_id AS "ownerId",q.last_allocated_number AS "lastAllocatedNumber",q.revision,q.created_at AS "createdAt",q.updated_at AS "updatedAt",q.summary_customer_name AS "customerName",q.summary_work_description AS "workDescription",q.summary_total_vnd::text AS total,q.latest_shared_version_id AS "latestSharedVersionId",d.id AS "draftVersionId",d.number AS "draftVersionNumber" FROM quotation q LEFT JOIN quotation_version d ON d.quotation_id=q.id AND d.state='DRAFT' WHERE ${Prisma.join(clauses,' AND ')} ORDER BY q.updated_at DESC,q.id DESC LIMIT ${filter.limit+1}`);
  }
  async summary(context:SessionContext,q:Quotation):Promise<SummaryRow>{
    const draft=await context.tx.quotationVersion.findFirst({where:{quotationId:q.id,state:"DRAFT"},select:{id:true,number:true}});
    return {id:q.id,reference:q.reference,ownerId:q.ownerId,lastAllocatedNumber:q.lastAllocatedNumber,revision:q.revision,createdAt:q.createdAt,updatedAt:q.updatedAt,customerName:q.summaryCustomerName,workDescription:q.summaryWorkDescription,total:q.summaryTotalVnd?.toString()??null,draftVersionId:draft?.id??null,draftVersionNumber:draft?.number??null,latestSharedVersionId:q.latestSharedVersionId};
  }
}
