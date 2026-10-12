import type { Request, Response } from "express";
import { AuthHttpContext } from "../auth/auth-http.js";
import { parseDto } from "../auth/auth.dto.js";
import { CompanyWriteDto } from "./company.dto.js";
import { CompanyService } from "./company.service.js";
export class CompanyController {
  constructor(private readonly service: CompanyService,private readonly http: AuthHttpContext) {}
  private async token(req: Request) {
    const token=this.http.token(req);await this.service.authorize(token);await this.http.sessionLimit(token);return token;
  }
  async read(req: Request,res: Response): Promise<void> {
    const result=await this.service.read(await this.token(req));res.setHeader("ETag",result.etag);res.json(result);
  }
  async update(req: Request,res: Response): Promise<void> {
    this.http.mutation(req);const token=await this.token(req),body=await parseDto(CompanyWriteDto,req.body);
    res.json(await this.service.update(token,req.get("X-CSRF-Token"),body,
      {epoch:req.get("X-Recovery-Epoch"),key:req.get("Idempotency-Key"),precondition:req.get("If-Match")}));
  }
}
