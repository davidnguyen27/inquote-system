import { Router } from "express";
import type { StaffController } from "./staff.controller.js";

export class StaffRoutes {
  public readonly router: Router;
  constructor(controller: StaffController) {
    this.router = Router();
    this.router.get("/staff", controller.list.bind(controller));
    this.router.get("/staff/:id", controller.read.bind(controller));
    this.router.post("/staff", controller.create.bind(controller));
    this.router.put("/staff/:id", controller.update.bind(controller));
    this.router.post("/staff/:id/credential-reset", controller.reset.bind(controller));
  }
}
