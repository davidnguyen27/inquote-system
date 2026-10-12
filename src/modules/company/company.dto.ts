import "reflect-metadata";
import { IsString, ValidateIf } from "class-validator";
export class CompanyWriteDto {
  @ValidateIf((_object,value)=>value!==null) @IsString() displayName!: string | null;
  @ValidateIf((_object,value)=>value!==null) @IsString() address!: string | null;
  @ValidateIf((_object,value)=>value!==null) @IsString() phone!: string | null;
  @ValidateIf((_object,value)=>value!==null) @IsString() email!: string | null;
}
