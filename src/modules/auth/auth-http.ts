import type { Request } from "express";
import { parse } from "cookie";
import type { AppConfig } from "../../config/env.js";
import { HttpProblem } from "../../http/problem.js";
import { RateLimitService } from "./rate-limit.service.js";
import { SessionService } from "./security.js";

export const cookieName = "__Host-inquote_session";

export class AuthHttpContext {
  constructor(private readonly config: AppConfig, private readonly limits: RateLimitService,
    private readonly security: SessionService) {}
  token(req: Request): string | undefined {
    const header = req.headers.cookie ?? "";
    if (header.split(";").filter(value => value.trim().startsWith(`${cookieName}=`)).length > 1) return undefined;
    return parse(header)[cookieName];
  }
  mutation(req: Request): void {
    this.origin(req);
    if (!req.is("application/json")) throw new HttpProblem(400, "INVALID_REQUEST");
  }
  origin(req: Request): void {
    if (req.get("Origin") !== this.config.adminOrigin) throw new HttpProblem(403, "FORBIDDEN");
  }
  async sessionLimit(token: string | undefined): Promise<void> {
    let digest: Uint8Array<ArrayBuffer>;
    try { digest = this.security.digest(token ?? ""); } catch { return; }
    await this.limits.consumeSession(digest);
  }
}
