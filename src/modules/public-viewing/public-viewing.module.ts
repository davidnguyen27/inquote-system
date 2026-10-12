import type {Router} from 'express';
import type {AppConfig} from '../../config/env.js';
import {Database} from '../../database/prisma.js';
import {RateLimitService} from '../auth/rate-limit.service.js';
import {PublicViewingRepository} from './public-viewing.repository.js';
import {PublicViewingService} from './public-viewing.service.js';
import {PublicViewingController} from './public-viewing.controller.js';
import {PublicViewingRoutes} from './public-viewing.routes.js';
export class PublicViewingModule {
  readonly router:Router;
  constructor(config:AppConfig,database:Database){this.router=new PublicViewingRoutes(new PublicViewingController(new PublicViewingService(config,new PublicViewingRepository(database)),new RateLimitService(database,config.rateLimitKey))).router;}
}
