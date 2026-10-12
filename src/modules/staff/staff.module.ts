import type { Router } from "express";
import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../database/prisma.js";
import { AuthRepository } from "../auth/auth.repository.js";
import { AuthHttpContext } from "../auth/auth-http.js";
import { PasswordService } from "../auth/password.service.js";
import { OperationReceiptService } from "../auth/operation-receipt.service.js";
import { RateLimitService } from "../auth/rate-limit.service.js";
import { SessionService } from "../auth/security.js";
import { StaffController } from "./staff.controller.js";
import { StaffRepository } from "./staff.repository.js";
import { StaffRoutes } from "./staff.routes.js";
import { StaffService } from "./staff.service.js";

export class StaffModule {
  public readonly router: Router;
  constructor(config: AppConfig, database: Database) {
    const security = new SessionService(config.csrfKey);
    const limits = new RateLimitService(database, config.rateLimitKey);
    const service = new StaffService(config, new AuthRepository(database, security, config.recoveryEpoch),
      new StaffRepository(), new PasswordService(), security, new OperationReceiptService(config), limits);
    this.router = new StaffRoutes(new StaffController(service, new AuthHttpContext(config, limits, security))).router;
  }
}
