import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { IsOptional, IsString, validate } from "class-validator";
import { HttpProblem } from "../../http/problem.js";

export class LoginDto {
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() password?: string;
}

export class ChangePasswordDto {
  @IsString() currentPassword!: string;
  @IsString() newPassword!: string;
}
export class EmptyDto {}

export async function parseDto<T extends object>(
  type: new () => T,
  body: unknown,
): Promise<T> {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new HttpProblem(400, "INVALID_REQUEST");
  // class-transformer strips these own fields; reject them before transformation to keep strict inputs.
  if (Object.hasOwn(body, "constructor") || Object.hasOwn(body, "__proto__"))
    throw new HttpProblem(400, "INVALID_REQUEST");
  if (type === EmptyDto) {
    if (Object.keys(body).length) throw new HttpProblem(400, "INVALID_REQUEST");
    return new type();
  }
  const dto = plainToInstance(type, body, { enableImplicitConversion: false });
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    validationError: { target: false, value: false },
  });
  if (errors.length) throw new HttpProblem(400, "INVALID_REQUEST");
  return dto;
}
