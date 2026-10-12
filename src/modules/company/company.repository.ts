import type { Prisma } from "../../generated/prisma/client.js";
import type { CompanyWriteDto } from "./company.dto.js";
export class CompanyRepository {
  read(tx: Prisma.TransactionClient) { return tx.companyProfile.findUniqueOrThrow({where:{id:1}}); }
  async lock(tx: Prisma.TransactionClient) {
    await tx.$queryRaw`SELECT id FROM company_profile WHERE id = 1 FOR UPDATE`;
    return this.read(tx);
  }
  update(tx: Prisma.TransactionClient, body: CompanyWriteDto, now: Date) {
    return tx.companyProfile.update({where:{id:1},data:{...body,revision:{increment:1},updatedAt:now}});
  }
}
