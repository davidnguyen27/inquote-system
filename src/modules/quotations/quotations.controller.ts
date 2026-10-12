import type {Request,Response} from "express";
import {HttpProblem} from "../../http/problem.js";
import {AuthHttpContext} from "../auth/auth-http.js";
import {EmptyDto,parseDto} from "../auth/auth.dto.js";
import {DraftWriteDto,QuotationListDto,VersionListDto,RefreshPreviewDto} from "./quotations.dto.js";
import {QuotationsService} from "./quotations.service.js";
export class QuotationsController {
  constructor(private readonly service:QuotationsService,private readonly http:AuthHttpContext){}
  private async token(req:Request){const token=this.http.token(req);await this.service.authorize(token);await this.http.sessionLimit(token);return token;}
  private headers(req:Request){return {epoch:req.get('X-Recovery-Epoch'),key:req.get('Idempotency-Key'),precondition:req.get('If-Match')};}
  private ids(req:Request){return [String(req.params.q),String(req.params.v)] as const;}
  async create(req:Request,res:Response){this.http.mutation(req);const token=await this.token(req);await parseDto(EmptyDto,req.body);const result=await this.service.create(token,req.get('X-CSRF-Token'),this.headers(req));const {quotationId,versionId}=result.operation.resourceIds as {quotationId:string;versionId:string};res.location(`/api/v1/quotations/${quotationId}/versions/${versionId}`).status(201).json(result);}
  async list(req:Request,res:Response){res.json(await this.service.list(await this.token(req),QuotationListDto.parse(req.query)));}
  async read(req:Request,res:Response){const result=await this.service.read(await this.token(req),String(req.params.q));res.setHeader('ETag',result.etag);res.json(result);}
  async history(req:Request,res:Response){res.json(await this.service.history(await this.token(req),String(req.params.q),VersionListDto.parse(req.query)));}
  async version(req:Request,res:Response){const result=await this.service.version(await this.token(req),...this.ids(req));res.setHeader('ETag',result.etag);res.json(result);}
  async save(req:Request,res:Response){this.http.mutation(req);const token=await this.token(req);DraftWriteDto.parse(req.body);res.json(await this.service.save(token,req.get('X-CSRF-Token'),...this.ids(req),req.body,this.headers(req)));}
  async discard(req:Request,res:Response){
    this.http.origin(req);
    const token=await this.token(req);
    // Non-JSON bodies bypass express.json; reject their framing as well as parsed input.
    if(req.body!==undefined||Number(req.get('Content-Length')??0)>0||req.get('Transfer-Encoding'))throw new HttpProblem(400,'INVALID_REQUEST');
    res.json(await this.service.discard(token,req.get('X-CSRF-Token'),...this.ids(req),this.headers(req)));
  }
  async preview(req:Request,res:Response){this.http.mutation(req);const token=await this.token(req);DraftWriteDto.parse(req.body);const result=await this.service.preview(token,...this.ids(req),req.body,req.get('If-Match'));res.setHeader('ETag',result.etag);res.json(result);}
  async refresh(req:Request,res:Response){this.http.mutation(req);res.json(await this.service.refresh(await this.token(req),...this.ids(req),String(req.params.line),RefreshPreviewDto.parse(req.body),req.get('If-Match')));}
}
