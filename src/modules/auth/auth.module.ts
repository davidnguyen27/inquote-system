import type { Router } from "express";
import type { AppConfig } from "../../config/env.js";
import { Database } from "../../database/prisma.js";
import { PasswordService } from "./password.service.js";
import { SessionService } from "./security.js";
import { AuthRepository } from "./auth.repository.js";
import { AuthService } from "./auth.service.js";
import { AuthController } from "./auth.controller.js";
import { AuthRoutes } from "./auth.routes.js";
import { RateLimitService } from "./rate-limit.service.js";
import { OperationReceiptService } from "./operation-receipt.service.js";

export class AuthModule {
  public readonly router: Router;

  constructor(config: AppConfig, database: Database) {
    const security = new SessionService(config.csrfKey);
    const repository = new AuthRepository(
      database,
      security,
      config.recoveryEpoch,
    );
    const service = new AuthService(
      config,
      repository,
      new PasswordService(),
      security,
      new OperationReceiptService(config),
    );
    const controller = new AuthController(
      config,
      service,
      new RateLimitService(database, config.rateLimitKey),
      security,
    );
    this.router = new AuthRoutes(controller).router;
  }
}
