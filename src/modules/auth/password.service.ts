import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { HttpProblem } from "../../http/problem.js";

export class PasswordService {
  private readonly common = new Set(
    readFileSync(
      new URL("../../../assets/auth/common-passwords.txt", import.meta.url),
      "utf8",
    )
      .split(/\r?\n/)
      .map((value) => value.toLowerCase()),
  );
  private dummy?: Promise<string>;

  constructor() {
    for (const value of [
      "passwordpassword",
      "123456789012345",
      "12345678901234567890",
    ])
      this.common.add(value);
  }
  validate(password: string): void {
    const length = [...password].length;
    if (
      length < 15 ||
      length > 128 ||
      /[\uD800-\uDFFF]/u.test(password) ||
      this.common.has(password.toLowerCase())
    ) {
      throw new HttpProblem(422, "VALIDATION_FAILED", [
        {
          pointer: "/newPassword",
          code: "PASSWORD_POLICY",
          message: "Use 15–128 characters and avoid common passwords.",
        },
      ]);
    }
  }
  hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
  }
  async verify(hash: string, password: string): Promise<boolean> {
    // UTF-8 replaces lone surrogates; reject them before Argon2 can alias another password.
    if (/[\uD800-\uDFFF]/u.test(password)) return false;
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }
  async dummyVerify(password: string): Promise<void> {
    this.dummy ??= this.hash(randomBytes(32).toString("base64url"));
    await this.verify(await this.dummy, password);
  }
}
