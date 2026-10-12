import type { CatalogItem } from "../../generated/prisma/client.js";
import { resourceETag } from "../common/common-data.js";
export class CatalogMapper {
  constructor(private readonly epoch: string) {}
  read(row: CatalogItem) {
    return {id:row.id,name:row.name,description:row.description,unit:row.unit,unitPrice:row.unitPriceVnd.toString(),
      active:row.active,revision:row.revision,sourceRevision:row.revision,etag:resourceETag("catalog",row.id,row.revision,this.epoch),
      createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString()};
  }
}
