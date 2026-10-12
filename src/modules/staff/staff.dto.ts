import "reflect-metadata";
import { IsBoolean, IsOptional, IsString } from "class-validator";

export class StaffCreateDto {
  @IsString() displayName!: string;
  @IsString() email!: string;
  @IsString() temporaryPassword!: string;
}
export class StaffUpdateDto {
  @IsString() displayName!: string;
  @IsBoolean() enabled!: boolean;
}
export class StaffResetDto {
  @IsString() temporaryPassword!: string;
}
export class StaffListDto {
  @IsOptional() @IsString() limit?: string;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() enabled?: string;
}
