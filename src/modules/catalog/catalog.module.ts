import type { Router } from "express";
import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../database/prisma.js";
import { AuthRepository } from "../auth/auth.repository.js";
import { AuthHttpContext } from "../auth/auth-http.js";
import { OperationReceiptService } from "../auth/operation-receipt.service.js";
import { RateLimitService } from "../auth/rate-limit.service.js";
import { SessionService } from "../auth/security.js";
import { CommonMutationService } from "../common/common-data.js";
import { CatalogController } from "./catalog.controller.js";
import { CatalogRepository } from "./catalog.repository.js";
import { CatalogRoutes } from "./catalog.routes.js";
import { CatalogService } from "./catalog.service.js";
export class CatalogModule {
  public readonly router: Router;
  constructor(config: AppConfig,database: Database) {
    const security=new SessionService(config.csrfKey),limits=new RateLimitService(database,config.rateLimitKey);
    const auth=new AuthRepository(database,security,config.recoveryEpoch);
    const service=new CatalogService(config,auth,new CatalogRepository(),new CommonMutationService(config,auth,security,new OperationReceiptService(config)));
    this.router=new CatalogRoutes(new CatalogController(service,new AuthHttpContext(config,limits,security))).router;
  }
}
