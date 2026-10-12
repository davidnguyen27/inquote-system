import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export function tokenBytes(token: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error("Invalid opaque token");
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== token)
    throw new Error("Invalid opaque token");
  return bytes;
}
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
export class SessionService {
  constructor(private readonly csrfKey: Buffer) {}
  issue(): string {
    return randomBytes(32).toString("base64url");
  }
  digest(token: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(
      createHash("sha256").update(tokenBytes(token)).digest(),
    );
  }
  csrf(token: string): string {
    return createHmac("sha256", this.csrfKey)
      .update(tokenBytes(token))
      .digest("base64url");
  }
  validCsrf(token: string, value: string | undefined): boolean {
    try {
      return equalBytes(tokenBytes(this.csrf(token)), tokenBytes(value ?? ""));
    } catch {
      return false;
    }
  }
}
export function staffETag(id: string, revision: number, epoch: string): string {
  return `"${createHash("sha256")
    .update(JSON.stringify(["staff", id, revision, epoch]))
    .digest("base64url")}"`;
}
export function fingerprint(
  key: Buffer,
  epoch: string,
  body: { currentPassword: string; newPassword: string },
  precondition: string,
): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    createHmac("sha256", key)
      .update(
        JSON.stringify([
          epoch,
          "POST",
          "/api/v1/auth/change-password",
          {
            currentPassword: body.currentPassword,
            newPassword: body.newPassword,
          },
          precondition,
        ]),
      )
      .digest(),
  );
}
