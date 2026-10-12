import type { Request, Response } from "express";
import { AuthHttpContext } from "../auth/auth-http.js";
import { parseDto } from "../auth/auth.dto.js";
import { CatalogWriteDto, CatalogListDto } from "./catalog.dto.js";
import { CatalogService } from "./catalog.service.js";
export class CatalogController {
  constructor(private readonly service: CatalogService,private readonly http: AuthHttpContext) {}
  private async token(req: Request) {
    const token=this.http.token(req);await this.service.authorize(token);await this.http.sessionLimit(token);return token;
  }
  private headers(req: Request) { return {epoch:req.get("X-Recovery-Epoch"),key:req.get("Idempotency-Key"),precondition:req.get("If-Match")}; }
  async list(req: Request,res: Response): Promise<void> { const token=await this.token(req);res.json(await this.service.list(token,await parseDto(CatalogListDto,req.query))); }
  async read(req: Request,res: Response): Promise<void> { const result=await this.service.read(await this.token(req),String(req.params.id));res.setHeader("ETag",result.etag);res.json(result); }
  async create(req: Request,res: Response): Promise<void> {
    this.http.mutation(req);const token=await this.token(req),body=await parseDto(CatalogWriteDto,req.body);
    res.status(201).json(await this.service.create(token,req.get("X-CSRF-Token"),body,this.headers(req)));
  }
  async update(req: Request,res: Response): Promise<void> {
    this.http.mutation(req);const token=await this.token(req),body=await parseDto(CatalogWriteDto,req.body);
    res.json(await this.service.update(token,req.get("X-CSRF-Token"),String(req.params.id),body,this.headers(req)));
  }
}
