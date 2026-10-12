import { Router } from "express";
import type { AuthController } from "./auth.controller.js";

export class AuthRoutes {
  public readonly router: Router;

  constructor(controller: AuthController) {
    this.router = Router();
    this.router.post("/auth/login", controller.login.bind(controller));
    this.router.get("/auth/session", controller.session.bind(controller));
    this.router.post("/auth/logout", controller.logout.bind(controller));
    this.router.post(
      "/auth/change-password",
      controller.changePassword.bind(controller),
    );
    this.router.get("/operations/:key", controller.operation.bind(controller));
  }
}
