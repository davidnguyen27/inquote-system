import "reflect-metadata";
import { IsBoolean, IsOptional, IsString, ValidateIf } from "class-validator";
export class CatalogWriteDto {
  @IsString() name!: string;
  @ValidateIf((_object,value)=>value!==null) @IsString() description!: string | null;
  @IsString() unit!: string;
  @IsString() unitPrice!: string;
  @IsBoolean() active!: boolean;
}
export class CatalogListDto {
  @IsOptional() @IsString() limit?: string;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() active?: string;
}
