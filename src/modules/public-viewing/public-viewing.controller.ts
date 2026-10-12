import type {Request,Response} from 'express';
import {RateLimitService} from '../auth/rate-limit.service.js';
import {PublicViewingService} from './public-viewing.service.js';
export class PublicViewingController {
  constructor(private readonly service:PublicViewingService,private readonly limits:RateLimitService){}
  async read(req:Request,res:Response){
    await this.limits.consume([{scope:'public_view',identity:req.ip??req.socket.remoteAddress??'unknown',limit:120,seconds:60}]);
    res.json(await this.service.read(req.body));
  }
}
