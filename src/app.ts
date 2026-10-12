import "reflect-metadata";
import express from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import swaggerUi from "swagger-ui-express";
import type { AppConfig } from "./config/env.js";
import { Database } from "./database/prisma.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { StaffModule } from "./modules/staff/staff.module.js";
import { CompanyModule } from "./modules/company/company.module.js";
import { CatalogModule } from "./modules/catalog/catalog.module.js";
import { QuotationsModule } from "./modules/quotations/quotations.module.js";
import { PublicViewingModule } from './modules/public-viewing/public-viewing.module.js';
import { HttpProblem, problemHandler } from "./http/problem.js";
import type { Telemetry } from "./observability/telemetry.js";

export function createApp(config: AppConfig, database: Database, telemetry?: Telemetry) {
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.set("trust proxy", config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { frameAncestors: ["'none'"] } },
      frameguard: { action: "deny" },
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.use((_req, res, next) => {
    res.locals.requestId = randomUUID();
    res.setHeader("X-Request-Id", res.locals.requestId);
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  if (telemetry) app.use(telemetry.middleware);
  app.use("/api/v1/quotations", express.json({ limit: "4mb", strict: true }));
  app.use(express.json({ limit: "16kb", strict: true }));
  if (config.apiDocsEnabled) {
    const contract = JSON.parse(
      readFileSync(
        new URL("../openapi/auth.openapi.json", import.meta.url),
        "utf8",
      ),
    );
    app.get("/", (_req, res) => res.redirect("/docs/"));
    app.get("/openapi.json", (_req, res) => res.json(contract));
    app.use(
      "/docs",
      helmet.contentSecurityPolicy({
        directives: {
          frameAncestors: ["'none'"],
          scriptSrc: ["'self'"],
          // Swagger's HTML and components use inline styles; scripts stay local.
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          // Keep development assets on HTTP; API responses retain the default CSP.
          upgradeInsecureRequests: null,
        },
      }),
      swaggerUi.serveWithOptions({
        cacheControl: false,
        etag: false,
        lastModified: false,
      }),
    );
    app.get(
      "/docs/",
      swaggerUi.setup(null, {
        customSiteTitle: "InQuote API Docs",
        swaggerUrl: "/openapi.json",
        swaggerOptions: { validatorUrl: null, persistAuthorization: false },
      }),
    );
  }
  app.use("/api/v1", new AuthModule(config, database).router);
  app.use("/api/v1", new StaffModule(config, database).router);
  app.use("/api/v1", new CompanyModule(config, database).router);
  app.use("/api/v1", new CatalogModule(config, database).router);
  app.use("/api/v1", new QuotationsModule(config, database).router);
  app.use('/api/v1',new PublicViewingModule(config,database).router);
  app.use((_req, _res, next) => next(new HttpProblem(404, "NOT_FOUND")));
  app.use(problemHandler);
  return app;
}
