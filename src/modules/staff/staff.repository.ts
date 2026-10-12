import type { Prisma } from "../../generated/prisma/client.js";

const fields = {
  id: true, displayName: true, normalizedEmail: true, role: true, enabled: true,
  mustChangePassword: true, temporaryCredentialExpiresAt: true, revision: true,
  createdAt: true, updatedAt: true,
} as const;
export type EmployeeRecord = Prisma.StaffUserGetPayload<{ select: typeof fields }>;

export class StaffRepository {
  employee(tx: Prisma.TransactionClient, id: string) {
    return tx.staffUser.findFirst({ where: { id, role: "EMPLOYEE" }, select: fields });
  }
  list(tx: Prisma.TransactionClient, where: Prisma.StaffUserWhereInput, limit: number) {
    return tx.staffUser.findMany({ where: { AND: [{ role: "EMPLOYEE" }, where] },
      select: fields, orderBy: [{ displayName: "asc" }, { id: "asc" }], take: limit + 1 });
  }
  create(tx: Prisma.TransactionClient, name: string, email: string, hash: string, now: Date) {
    return tx.staffUser.create({ data: { displayName: name, normalizedEmail: email,
      role: "EMPLOYEE", enabled: true, passwordHash: hash, mustChangePassword: true,
      temporaryCredentialExpiresAt: new Date(now.getTime() + 86400000), createdAt: now, updatedAt: now }, select: fields });
  }
  update(tx: Prisma.TransactionClient, id: string, name: string, enabled: boolean, now: Date) {
    return tx.staffUser.update({ where: { id }, data: { displayName: name, enabled,
      revision: { increment: 1 }, updatedAt: now }, select: fields });
  }
  reset(tx: Prisma.TransactionClient, id: string, hash: string, now: Date) {
    return tx.staffUser.update({ where: { id }, data: { passwordHash: hash, mustChangePassword: true,
      temporaryCredentialExpiresAt: new Date(now.getTime() + 86400000), revision: { increment: 1 }, updatedAt: now }, select: fields });
  }
  revokeSessions(tx: Prisma.TransactionClient, id: string, now: Date) {
    return tx.staffSession.updateMany({ where: { staffId: id, revokedAt: null }, data: { revokedAt: now } });
  }
}
