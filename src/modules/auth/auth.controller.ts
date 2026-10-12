import type { Request, Response } from "express";
import { serialize } from "cookie";
import type { AppConfig } from "../../config/env.js";
import { AuthService } from "./auth.service.js";
import { LoginDto, ChangePasswordDto, EmptyDto, parseDto } from "./auth.dto.js";
import { RateLimitService } from "./rate-limit.service.js";
import { SessionService } from "./security.js";
import { AuthHttpContext, cookieName } from "./auth-http.js";

export { cookieName } from "./auth-http.js";
const cookieOptions = {
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
};
export class AuthController {
  private readonly http: AuthHttpContext;
  constructor(
    config: AppConfig,
    private readonly service: AuthService,
    private readonly limits: RateLimitService,
    security: SessionService,
  ) { this.http = new AuthHttpContext(config, limits, security); }
  private token(req: Request): string | undefined {
    return this.http.token(req);
  }

  private mutation(req: Request): void {
    this.http.mutation(req);
  }

  private async sessionLimit(token: string | undefined): Promise<void> {
    await this.http.sessionLimit(token);
  }

  async login(req: Request, res: Response): Promise<void> {
    this.mutation(req);
    const body = await parseDto(LoginDto, req.body);
    await this.limits.consume([
      {
        scope: "login_email",
        identity: body.email?.trim().toLowerCase() ?? "",
        limit: 10,
        seconds: 900,
      },
      {
        scope: "login_ip",
        identity: req.ip ?? req.socket.remoteAddress ?? "unknown",
        limit: 30,
        seconds: 900,
      },
    ]);
    const result = await this.service.login(body);
    res.setHeader(
      "Set-Cookie",
      serialize(cookieName, result.token, cookieOptions),
    );
    res.json(result.summary);
  }

  async session(req: Request, res: Response): Promise<void> {
    const token = this.token(req);
    await this.sessionLimit(token);
    res.json(await this.service.inspect(token));
  }

  async logout(req: Request, res: Response): Promise<void> {
    this.mutation(req);
    await parseDto(EmptyDto, req.body);
    const token = this.token(req);
    await this.sessionLimit(token);
    await this.service.logout(token, req.get("X-CSRF-Token"));
    res.setHeader(
      "Set-Cookie",
      serialize(cookieName, "", { ...cookieOptions, maxAge: 0 }),
    );
    res.sendStatus(204);
  }

  async changePassword(req: Request, res: Response): Promise<void> {
    this.mutation(req);
    const token = this.token(req);
    const body = await parseDto(ChangePasswordDto, req.body);
    await this.sessionLimit(token);
    const result = await this.service.changePassword(
      token,
      req.get("X-CSRF-Token"),
      body,
      {
        epoch: req.get("X-Recovery-Epoch"),
        key: req.get("Idempotency-Key"),
        precondition: req.get("If-Match"),
      },
    );
    if (!result.replayed)
      res.setHeader(
        "Set-Cookie",
        serialize(cookieName, "", { ...cookieOptions, maxAge: 0 }),
      );
    res.json({ operation: result.operation });
  }

  async operation(req: Request, res: Response): Promise<void> {
    const token = this.token(req);
    await this.sessionLimit(token);
    res.json(
      await this.service.operation(
        token,
        String(req.params.key),
        req.get("X-Recovery-Epoch"),
      ),
    );
  }
}
