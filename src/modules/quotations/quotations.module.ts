import type {Router} from "express";
import type {AppConfig} from "../../config/env.js";
import type {Database} from "../../database/prisma.js";
import {AuthRepository} from "../auth/auth.repository.js";
import {AuthHttpContext} from "../auth/auth-http.js";
import {SessionService} from "../auth/security.js";
import {RateLimitService} from "../auth/rate-limit.service.js";
import {QuotationsRepository} from "./quotations.repository.js";
import {QuotationsService} from "./quotations.service.js";
import {QuotationsController} from "./quotations.controller.js";
import {QuotationsRoutes} from "./quotations.routes.js";
import {PublicationService} from './publication.service.js';
import {PublicationController} from './publication.controller.js';
import {PublicationRoutes} from './publication.routes.js';
export class QuotationsModule {
  public readonly router:Router;
  constructor(config:AppConfig,database:Database){
    const security=new SessionService(config.csrfKey),auth=new AuthRepository(database,security,config.recoveryEpoch),http=new AuthHttpContext(config,new RateLimitService(database,config.rateLimitKey),security),repository=new QuotationsRepository(),service=new QuotationsService(config,auth,security,repository);
    this.router=new QuotationsRoutes(new QuotationsController(service,http)).router;
    this.router.use(new PublicationRoutes(new PublicationController(new PublicationService(config,auth,repository,service),service,http)).router);
  }
}
