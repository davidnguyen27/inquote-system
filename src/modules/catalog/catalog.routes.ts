import { Router } from "express";
import type { CatalogController } from "./catalog.controller.js";
export class CatalogRoutes {
  public readonly router: Router;
  constructor(controller: CatalogController) {
    this.router=Router();this.router.get("/catalog-items",controller.list.bind(controller));this.router.get("/catalog-items/:id",controller.read.bind(controller));
    this.router.post("/catalog-items",controller.create.bind(controller));this.router.put("/catalog-items/:id",controller.update.bind(controller));
  }
}
