import {isUUID} from "class-validator";
import {VndCalculator,VndValidationError} from "../../domain/money.js";
import {HttpProblem} from "../../http/problem.js";
import {textField,emailField} from "../../http/text-validation.js";
import {DraftWriteDto,exactObject,type Customer,type Work,type LineInput} from "./quotations.dto.js";
export type Source={id:string;active:boolean;revision:number;unit:string;unitPriceVnd:bigint};
export type SavedLine={lineId:string;kind:"CUSTOM"|"CATALOG";description:string|null;unit:string|null;quantity:string|null;unitPrice:string|null;amount:string|null;sourceCatalogId?:string;sourceRevision?:number;baseUnitPrice?:string;overrideUnitPrice?:string|null};
export type Content={currency:"VND";customer:Customer;work:Work;terms:string|null;lines:SavedLine[];calculation:{complete:boolean;subtotal:string;total:string|null}};
export class DraftDocument {
  private readonly money=new VndCalculator();
  static empty():Content{return {currency:"VND",customer:{name:null,contactPerson:null,phone:null,email:null,address:null},work:{description:null,siteAddress:null},terms:null,lines:[],calculation:{complete:false,subtotal:"0",total:null}};}
  sources(body:unknown,saved:SavedLine[]):string[]{
    const dto=DraftWriteDto.parse(body),previous=new Map(saved.map(line=>[line.lineId,line]));const ids=new Set<string>();
    for(const line of dto.lines)if(line.kind==="CATALOG"){
      const old=previous.get(line.lineId);const id=old?.kind==="CATALOG"?old.sourceCatalogId:line.sourceCatalogId;
      if(!old||Object.hasOwn(line,"refreshSourceRevision")){if(typeof id!=="string"||!isUUID(id))throw new HttpProblem(400,"INVALID_REQUEST");ids.add(id.toLowerCase());}
    }
    return [...ids].sort();
  }
  number(value:unknown,pointer:string,quantity=false):string|null {
    if(value===null)return null;
    try{return quantity?this.money.parseQuantity(value as string):this.money.parseUnitPrice(value as string);}
    catch(error){if(error instanceof VndValidationError)throw this.invalid(pointer,error.code);throw error;}
  }
  string(value:unknown,pointer:string,max:number):string|null {
    return textField(value,pointer,max);
  }
  resolve(body:unknown,saved:SavedLine[],sources:Map<string,Source>):Content {
    const dto=DraftWriteDto.parse(body),previous=new Map(saved.map(line=>[line.lineId,line]));
    const customer:Customer={name:this.string(dto.customer.name,"/customer/name",200),contactPerson:this.string(dto.customer.contactPerson,"/customer/contactPerson",200),phone:this.string(dto.customer.phone,"/customer/phone",50),email:this.string(dto.customer.email,"/customer/email",254),address:this.string(dto.customer.address,"/customer/address",500)};
    // Preserve customer text-error order before checking the email's syntax.
    customer.email=emailField(customer.email,"/customer/email","contact","Supply a valid value within the documented limits.");
    const work:Work={description:this.string(dto.work.description,"/work/description",200),siteAddress:this.string(dto.work.siteAddress,"/work/siteAddress",500)};
    const terms=this.string(dto.terms,"/terms",5000);
    const lines=dto.lines.map((line,index):SavedLine=>{
      const pointer=`/lines/${index}`,old=previous.get(line.lineId);
      if(old&&old.kind!==line.kind)throw new HttpProblem(400,"INVALID_REQUEST");
      const description=this.string(line.description,pointer+"/description",500),quantity=this.number(line.quantity,pointer+"/quantity",true);
      if(line.kind==="CUSTOM"){
        exactObject(line,["lineId","kind","description","unit","quantity","unitPrice"]);
        return {lineId:line.lineId,kind:line.kind,description,unit:this.string(line.unit,pointer+"/unit",50),quantity,unitPrice:this.number(line.unitPrice,pointer+"/unitPrice"),amount:null};
      }
      const overrideUnitPrice=this.number(line.overrideUnitPrice,pointer+"/overrideUnitPrice");
      let sourceCatalogId:string,sourceRevision:number,unit:string,baseUnitPrice:string;
      if(!old){
        exactObject(line,["lineId","kind","description","quantity","sourceCatalogId","sourceRevision","overrideUnitPrice"]);
        if(typeof line.sourceCatalogId!=="string"||!isUUID(line.sourceCatalogId))throw new HttpProblem(400,"INVALID_REQUEST");
        sourceCatalogId=line.sourceCatalogId.toLowerCase();const source=this.source(sources,sourceCatalogId,line.sourceRevision);
        sourceRevision=source.revision;unit=source.unit;baseUnitPrice=source.unitPriceVnd.toString();
      }else{
        exactObject(line,["lineId","kind","description","quantity","overrideUnitPrice","refreshSourceRevision"],["lineId","kind","description","quantity","overrideUnitPrice"]);
        sourceCatalogId=old.sourceCatalogId!;sourceRevision=old.sourceRevision!;unit=old.unit!;baseUnitPrice=old.baseUnitPrice!;
        if(Object.hasOwn(line,"refreshSourceRevision")){const source=this.source(sources,sourceCatalogId,line.refreshSourceRevision);if(source.unit!==unit)throw new HttpProblem(409,"UNIT_MISMATCH");sourceRevision=source.revision;baseUnitPrice=source.unitPriceVnd.toString();}
      }
      return {lineId:line.lineId,kind:line.kind,description,unit,quantity,unitPrice:overrideUnitPrice??baseUnitPrice,amount:null,sourceCatalogId,sourceRevision,baseUnitPrice,overrideUnitPrice};
    });
    let calculation:ReturnType<VndCalculator["calculateQuotation"]>;
    try{calculation=this.money.calculateQuotation(lines);}catch(error){if(error instanceof VndValidationError)throw this.invalid(error.pointer,error.code);throw error;}
    return {currency:"VND",customer,work,terms,lines:lines.map((line,index)=>({...line,amount:calculation.lines[index]!.amount})),calculation:{complete:calculation.complete,subtotal:calculation.subtotal,total:calculation.total}};
  }
  source(sources:Map<string,Source>,id:string,revision:unknown):Source{
    if(!Number.isSafeInteger(revision)||Number(revision)<1)throw new HttpProblem(400,"INVALID_REQUEST");
    const source=sources.get(id);if(!source?.active)throw new HttpProblem(409,"SOURCE_UNAVAILABLE");if(source.revision!==revision)throw new HttpProblem(409,"CATALOG_CHANGED");return source;
  }
  private invalid(pointer:string,code:string){return new HttpProblem(422,"VALIDATION_FAILED",[{pointer,code,message:"Supply a valid value within the documented limits."}]);}
}
