import {isUUID} from "class-validator";
import {HttpProblem} from "../../http/problem.js";
export function exactObject(value: unknown, allowed: readonly string[], required: readonly string[]=allowed): Record<string,unknown> {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new HttpProblem(400,"INVALID_REQUEST");
  const object=value as Record<string,unknown>;
  if(Object.keys(object).some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(object,key)))throw new HttpProblem(400,"INVALID_REQUEST");
  return object;
}
export type Customer={name:string|null;contactPerson:string|null;phone:string|null;email:string|null;address:string|null};
export type Work={description:string|null;siteAddress:string|null};
export type LineInput=Record<string,unknown>&{lineId:string;kind:"CUSTOM"|"CATALOG"};
export class DraftWriteDto {
  constructor(public readonly customer:Record<string,unknown>,public readonly work:Record<string,unknown>,public readonly terms:unknown,public readonly lines:LineInput[]){}
  static parse(value:unknown):DraftWriteDto {
    const object=exactObject(value,["customer","work","terms","lines"]);
    const customer=exactObject(object.customer,["name","contactPerson","phone","email","address"]);
    const work=exactObject(object.work,["description","siteAddress"]);
    if(!Array.isArray(object.lines))throw new HttpProblem(400,"INVALID_REQUEST");
    if(object.lines.length>1000)throw new HttpProblem(422,"VALIDATION_FAILED",[{pointer:"/lines",code:"NUMERIC_LIMIT",message:"Use at most 1000 lines."}]);
    const ids=new Set<string>();
    const lines=object.lines.map(value=>{
      const line=exactObject(value,["lineId","kind","description","unit","quantity","unitPrice","sourceCatalogId","sourceRevision","overrideUnitPrice","refreshSourceRevision"],["lineId","kind","description","quantity"]);
      if(typeof line.lineId!=="string"||!isUUID(line.lineId)||typeof line.kind!=="string"||!["CUSTOM","CATALOG"].includes(line.kind))throw new HttpProblem(400,"INVALID_REQUEST");
      const id=line.lineId.toLowerCase();if(ids.has(id))throw new HttpProblem(400,"INVALID_REQUEST");ids.add(id);
      return {...line,lineId:id} as LineInput;
    });
    return new DraftWriteDto(customer,work,object.terms,lines);
  }
}
export class RefreshPreviewDto {
  constructor(public readonly quantity:unknown,public readonly overrideUnitPrice:unknown){}
  static parse(value:unknown){const body=exactObject(value,["quantity","overrideUnitPrice"]);return new RefreshPreviewDto(body.quantity,body.overrideUnitPrice);}
}
export class ShareWriteDto {
  constructor(public readonly reviewToken:string){}
  static parse(value:unknown){const body=exactObject(value,['reviewToken']);if(typeof body.reviewToken!=='string'||body.reviewToken.length>4096)throw new HttpProblem(400,'INVALID_REQUEST');return new ShareWriteDto(body.reviewToken);}
}
export class QuotationListDto {
  constructor(public readonly query:Record<string,unknown>){}
  static parse(value:unknown){return new QuotationListDto(exactObject(value,["limit","search","hasDraft","hasShared","ownerId","cursor"],[]));}
}
export class VersionListDto {
  constructor(public readonly query:Record<string,unknown>){}
  static parse(value:unknown){return new VersionListDto(exactObject(value,["limit","cursor"],[]));}
}
