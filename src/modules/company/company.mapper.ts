import type { CompanyProfile } from "../../generated/prisma/client.js";
import { resourceETag } from "../common/common-data.js";
export class CompanyMapper {
  constructor(private readonly epoch: string) {}
  read(row: CompanyProfile) {
    return {id:1,displayName:row.displayName,address:row.address,phone:row.phone,email:row.email,
      revision:row.revision,etag:resourceETag("company",1,row.revision,this.epoch),
      createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString()};
  }
}
