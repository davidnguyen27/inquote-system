import type { Prisma } from "../../generated/prisma/client.js";
type CatalogData={name:string;description:string|null;unit:string;unitPriceVnd:bigint;active:boolean};
export class CatalogRepository {
  read(tx: Prisma.TransactionClient,id: string) { return tx.catalogItem.findUnique({where:{id}}); }
  async lock(tx: Prisma.TransactionClient,id: string) {
    await tx.$queryRaw`SELECT id FROM catalog_item WHERE id = ${id}::uuid FOR UPDATE`;
    return this.read(tx,id);
  }
  list(tx: Prisma.TransactionClient,where: Prisma.CatalogItemWhereInput,limit: number) {
    return tx.catalogItem.findMany({where,orderBy:[{name:"asc"},{id:"asc"}],take:limit+1});
  }
  create(tx: Prisma.TransactionClient,data: CatalogData,now: Date) {
    return tx.catalogItem.create({data:{...data,createdAt:now,updatedAt:now}});
  }
  update(tx: Prisma.TransactionClient,id: string,data: CatalogData,now: Date) {
    return tx.catalogItem.update({where:{id},data:{...data,revision:{increment:1},updatedAt:now}});
  }
}
