import type { Router } from "express";
import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../database/prisma.js";
import { AuthRepository } from "../auth/auth.repository.js";
import { AuthHttpContext } from "../auth/auth-http.js";
import { OperationReceiptService } from "../auth/operation-receipt.service.js";
import { RateLimitService } from "../auth/rate-limit.service.js";
import { SessionService } from "../auth/security.js";
import { CommonMutationService } from "../common/common-data.js";
import { CompanyController } from "./company.controller.js";
import { CompanyRepository } from "./company.repository.js";
import { CompanyRoutes } from "./company.routes.js";
import { CompanyService } from "./company.service.js";
export class CompanyModule {
  public readonly router: Router;
  constructor(config: AppConfig,database: Database) {
    const security=new SessionService(config.csrfKey),limits=new RateLimitService(database,config.rateLimitKey);
    const auth=new AuthRepository(database,security,config.recoveryEpoch);
    const service=new CompanyService(config,auth,new CompanyRepository(),new CommonMutationService(config,auth,security,new OperationReceiptService(config)));
    this.router=new CompanyRoutes(new CompanyController(service,new AuthHttpContext(config,limits,security))).router;
  }
}
