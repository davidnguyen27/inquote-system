import {Router} from "express";
import type {QuotationsController} from "./quotations.controller.js";
export class QuotationsRoutes {
  public readonly router:Router;
  constructor(controller:QuotationsController){this.router=Router();
    this.router.get('/quotations',controller.list.bind(controller));this.router.post('/quotations',controller.create.bind(controller));
    this.router.get('/quotations/:q',controller.read.bind(controller));this.router.get('/quotations/:q/versions',controller.history.bind(controller));this.router.get('/quotations/:q/versions/:v',controller.version.bind(controller));
    this.router.put('/quotations/:q/versions/:v/draft',controller.save.bind(controller));this.router.delete('/quotations/:q/versions/:v/draft',controller.discard.bind(controller));
    this.router.post('/quotations/:q/versions/:v/draft-preview',controller.preview.bind(controller));this.router.post('/quotations/:q/versions/:v/lines/:line/price-refresh-preview',controller.refresh.bind(controller));
  }
}
