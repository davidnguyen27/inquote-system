import type { AppConfig } from "../../config/env.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { VndCalculator, VndValidationError } from "../../domain/money.js";
import { HttpProblem } from "../../http/problem.js";
import { AuthRepository } from "../auth/auth.repository.js";
import { CatalogCursor, CommonMutationService, requireId, resourceETag, type WriteHeaders } from "../common/common-data.js";
import { validateText } from "../../domain/text.js";
import { textField } from "../../http/text-validation.js";
import type { CatalogListDto, CatalogWriteDto } from "./catalog.dto.js";
import { CatalogMapper } from "./catalog.mapper.js";
import { CatalogRepository } from "./catalog.repository.js";
export class CatalogService {
  private readonly mapper: CatalogMapper;
  private readonly cursors: CatalogCursor;
  private readonly money=new VndCalculator();
  constructor(private readonly config: AppConfig,private readonly auth: AuthRepository,
    private readonly repository: CatalogRepository,private readonly mutations: CommonMutationService) {
    this.mapper=new CatalogMapper(config.recoveryEpoch);this.cursors=new CatalogCursor(config);
  }
  authorize(token: string | undefined) { return this.mutations.authorize(token); }
  list(token: string | undefined,query: CatalogListDto) {
    return this.auth.withSession(token,{allowLimited:false},async context=>{
      const limit=Number(query.limit??"25"),parsed=validateText(query.search??"",{maxCodePoints:200});
      if(!/^[1-9]\d*$/.test(query.limit??"25") || limit>100 || !parsed.ok ||
        (query.active!==undefined && !["true","false"].includes(query.active)))throw new HttpProblem(400,"INVALID_REQUEST");
      const search=parsed.value??"";
      if(context.staff.role!=="ADMINISTRATOR" && query.active==="false")throw new HttpProblem(403,"FORBIDDEN");
      const active=context.staff.role==="ADMINISTRATOR" ? query.active : "true";
      const filter=[search,query.active??"",limit];
      const clauses: Prisma.CatalogItemWhereInput[]=[
        ...(search?[{OR:[{name:{contains:search,mode:"insensitive" as const}},{description:{contains:search,mode:"insensitive" as const}}]}]:[]),
        ...(active===undefined?[]:[{active:active==="true"}]),
      ];
      if(query.cursor!==undefined){const [name,id]=this.cursors.read(query.cursor,filter);clauses.push({OR:[{name:{gt:name}},{name,id:{gt:id}}]});}
      const rows=await this.repository.list(context.tx,{AND:clauses},limit),items=rows.slice(0,limit),last=items.at(-1);
      return {items:items.map(row=>this.mapper.read(row)),nextCursor:rows.length>limit&&last?this.cursors.create(filter,last.name,last.id):null};
    });
  }
  read(token: string | undefined,id: string) {
    id=requireId(id);
    return this.auth.withSession(token,{allowLimited:false},async context=>{
      const row=await this.repository.read(context.tx,id);
      if(!row || (context.staff.role!=="ADMINISTRATOR" && !row.active))throw new HttpProblem(404,"NOT_FOUND");
      return this.mapper.read(row);
    });
  }
  create(token: string | undefined,csrf: string | undefined,body: CatalogWriteDto,headers: WriteHeaders) {
    return this.write(token,csrf,body,headers);
  }
  update(token: string | undefined,csrf: string | undefined,id: string,body: CatalogWriteDto,headers: WriteHeaders) {
    return this.write(token,csrf,body,headers,requireId(id));
  }
  private write(token: string | undefined,csrf: string | undefined,body: CatalogWriteDto,headers: WriteHeaders,id?: string) {
    return this.mutations.write(token,csrf,headers,{kind:id?"UPDATE_CATALOG_ITEM":"CREATE_CATALOG_ITEM",method:id?"PUT":"POST",
      route:"/api/v1/catalog-items"+(id?"/"+id:""),body:{name:body.name,description:body.description,unit:body.unit,unitPrice:body.unitPrice,active:body.active}},async(context,precondition)=>{
      if(id){const current=await this.repository.lock(context.tx,id);if(!current)throw new HttpProblem(404,"NOT_FOUND");
        if(precondition!==resourceETag("catalog",id,current.revision,this.config.recoveryEpoch))throw new HttpProblem(412,"REVISION_CONFLICT");}
      const data={name:textField(body.name,"/name",200,true)!,description:textField(body.description,"/description",500),unit:textField(body.unit,"/unit",50,true)!,
        unitPriceVnd:this.price(body.unitPrice),active:body.active};
      const saved=id?await this.repository.update(context.tx,id,data,context.now):await this.repository.create(context.tx,data,context.now);
      return {resourceIds:{catalogItemId:saved.id},appliedRevisions:{catalogItem:saved.revision}};
    });
  }
  private price(value: string): bigint {
    try { return BigInt(this.money.parseUnitPrice(value)); }
    catch(error) {
      if(error instanceof VndValidationError)throw new HttpProblem(422,"VALIDATION_FAILED",[{pointer:error.pointer,code:error.code,message:"Use a whole VND price from 0 to 1000000000000."}]);
      throw error;
    }
  }
}
