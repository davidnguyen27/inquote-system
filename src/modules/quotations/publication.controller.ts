import type {Request,Response} from 'express';
import {AuthHttpContext} from '../auth/auth-http.js';
import {EmptyDto,parseDto} from '../auth/auth.dto.js';
import {ShareWriteDto} from './quotations.dto.js';
import {QuotationsService} from './quotations.service.js';
import {PublicationService} from './publication.service.js';
export class PublicationController {
  constructor(private readonly service:PublicationService,private readonly quotations:QuotationsService,private readonly http:AuthHttpContext){}
  private async token(req:Request){const token=this.http.token(req);await this.quotations.authorize(token);await this.http.sessionLimit(token);return token;}
  private ids(req:Request){return [String(req.params.q),String(req.params.v)] as const;}
  private headers(req:Request){return {epoch:req.get('X-Recovery-Epoch'),key:req.get('Idempotency-Key'),precondition:req.get('If-Match')};}
  async revision(req:Request,res:Response){
    this.http.mutation(req);const token=await this.token(req);await parseDto(EmptyDto,req.body);
    const result=await this.service.revision(token,req.get('X-CSRF-Token'),String(req.params.q),this.headers(req));
    const ids=result.operation.resourceIds as {quotationId:string;versionId:string};res.location(`/api/v1/quotations/${ids.quotationId}/versions/${ids.versionId}`).status(result.operation.kind==='REUSE_DRAFT'?200:201).json(result);
  }
  async review(req:Request,res:Response){this.http.mutation(req);const token=await this.token(req);await parseDto(EmptyDto,req.body);res.json(await this.service.review(token,...this.ids(req),req.get('If-Match')));}
  async share(req:Request,res:Response){
    this.http.mutation(req);const token=await this.token(req),body=ShareWriteDto.parse(req.body);
    res.json(await this.service.share(token,req.get('X-CSRF-Token'),...this.ids(req),body.reviewToken,this.headers(req)));
  }
  async access(req:Request,res:Response){const result=await this.service.access(await this.token(req),...this.ids(req));if('etag' in result&&result.etag)res.setHeader('ETag',result.etag);res.json(result);}
  async link(req:Request,res:Response){res.json(await this.service.link(await this.token(req),...this.ids(req),req.get('If-Match')));}
  async revoke(req:Request,res:Response){return this.change(req,res,false);}
  async replace(req:Request,res:Response){return this.change(req,res,true);}
  private async change(req:Request,res:Response,replace:boolean){this.http.mutation(req);const token=await this.token(req);await parseDto(EmptyDto,req.body);res.json(await this.service.changeAccess(token,req.get('X-CSRF-Token'),...this.ids(req),replace,this.headers(req)));}
}
