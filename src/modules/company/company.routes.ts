import { Router } from "express";
import type { CompanyController } from "./company.controller.js";
export class CompanyRoutes {
  public readonly router: Router;
  constructor(controller: CompanyController) {
    this.router=Router();this.router.get("/company",controller.read.bind(controller));this.router.put("/company",controller.update.bind(controller));
  }
}
