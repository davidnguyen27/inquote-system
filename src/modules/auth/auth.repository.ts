import type {
  Prisma,
  StaffUser,
  StaffSession,
} from "../../generated/prisma/client.js";
import { Database } from "../../database/prisma.js";
import { HttpProblem } from "../../http/problem.js";
import { SessionService } from "./security.js";

export interface SessionContext {
  tx: Prisma.TransactionClient;
  staff: StaffUser;
  session: StaffSession;
  now: Date;
  token: string;
}
export class AuthRepository {
  constructor(
    public readonly database: Database,
    private readonly tokens: SessionService,
    private readonly epoch: string,
  ) {}
  async clock(tx: Prisma.TransactionClient): Promise<Date> {
    const rows = await tx.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS now`;
    return rows[0]!.now;
  }
  async lockStaff(
    tx: Prisma.TransactionClient,
    id: string,
    exclusive: boolean,
  ): Promise<StaffUser | null> {
    if (exclusive)
      await tx.$queryRaw`SELECT id FROM staff_user WHERE id = ${id}::uuid FOR UPDATE`;
    else
      await tx.$queryRaw`SELECT id FROM staff_user WHERE id = ${id}::uuid FOR SHARE`;
    return tx.staffUser.findUnique({ where: { id } });
  }
  async withSession<T>(
    token: string | undefined,
    options: { allowLimited: boolean; exclusiveStaff?: boolean; staffIds?: string[] },
    work: (context: SessionContext) => Promise<T>,
  ): Promise<T> {
    let digest: Uint8Array<ArrayBuffer>;
    try {
      digest = this.tokens.digest(token ?? "");
    } catch {
      throw new HttpProblem(401, "SESSION_REQUIRED");
    }
    const observed = await this.database.client.staffSession.findUnique({
      where: { tokenHash: digest },
    });
    if (!observed) throw new HttpProblem(401, "SESSION_REQUIRED");
    return this.database.transaction(async (tx) => {
      // Lock every actor/target before sessions, in one order without lock upgrades.
      let staff: StaffUser | null = null;
      for (const id of [...new Set([observed.staffId, ...(options.staffIds ?? [])])].sort()) {
        const row = await this.lockStaff(tx, id, options.exclusiveStaff ?? false);
        if (id === observed.staffId) staff = row;
      }
      await tx.$queryRaw`SELECT id FROM staff_session WHERE id = ${observed.id}::uuid FOR UPDATE`;
      const session = await tx.staffSession.findUnique({
        where: { id: observed.id },
      });
      const now = await this.clock(tx);
      if (
        !staff?.enabled ||
        !session ||
        session.revokedAt ||
        session.recoveryEpoch !== this.epoch ||
        now >= session.absoluteExpiresAt ||
        now.getTime() - session.lastSeenAt.getTime() >= 30 * 60 * 1000 ||
        (staff.mustChangePassword &&
          (!staff.temporaryCredentialExpiresAt ||
            now >= staff.temporaryCredentialExpiresAt))
      ) {
        throw new HttpProblem(401, "SESSION_REQUIRED");
      }
      if (staff.mustChangePassword && !options.allowLimited)
        throw new HttpProblem(403, "PASSWORD_CHANGE_REQUIRED");
      await tx.staffSession.update({
        where: { id: session.id },
        data: { lastSeenAt: now },
      });
      return work({ tx, staff, session, now, token: token! });
    });
  }
}
