import {Router} from 'express';
import type {PublicViewingController} from './public-viewing.controller.js';
export class PublicViewingRoutes {
  readonly router=Router();
  constructor(controller:PublicViewingController){this.router.post('/public/quotation-view',controller.read.bind(controller));}
}
