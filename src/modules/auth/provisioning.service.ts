import { isEmail } from "class-validator";
import { Database } from "../../database/prisma.js";
import { HttpProblem } from "../../http/problem.js";
import { PasswordService } from "./password.service.js";
import {invalidText} from '../common/common-data.js';

export class AdministratorProvisioningService {
  constructor(
    private readonly database: Database,
    private readonly passwords: PasswordService,
  ) {}
  private email(value: string): string {
    const email = value.trim().toLowerCase();
    if (email.length > 254 || !isEmail(email))
      throw new HttpProblem(400, "INVALID_REQUEST");
    return email;
  }
  async bootstrap(
    emailInput: string,
    displayName: string,
    password: string,
  ): Promise<string> {
    const email = this.email(emailInput),
      name = displayName.trim();
    if (!name || [...name].length > 200 || invalidText(name))
      throw new HttpProblem(400, "INVALID_REQUEST");
    this.passwords.validate(password);
    const hash = await this.passwords.hash(password);
    return this.database.transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('inquote:administrator-provisioning', 0))::text AS locked`;
      if (
        await tx.staffUser.findFirst({
          where: { role: "ADMINISTRATOR" },
          select: { id: true },
        })
      )
        throw new HttpProblem(409, "ADMINISTRATOR_EXISTS");
      if (
        await tx.staffUser.findUnique({
          where: { normalizedEmail: email },
          select: { id: true },
        })
      )
        throw new HttpProblem(409, "EMAIL_ALREADY_EXISTS");
      const staff = await tx.staffUser.create({
        data: {
          normalizedEmail: email,
          displayName: name,
          role: "ADMINISTRATOR",
          passwordHash: hash,
        },
      });
      return staff.id;
    });
  }
  async reset(emailInput: string, password: string): Promise<string> {
    const email = this.email(emailInput);
    this.passwords.validate(password);
    const hash = await this.passwords.hash(password);
    return this.database.transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('inquote:administrator-provisioning', 0))::text AS locked`;
      const observed = await tx.staffUser.findUnique({
        where: { normalizedEmail: email },
        select: { id: true },
      });
      if (!observed) throw new HttpProblem(404, "NOT_FOUND");
      await tx.$queryRaw`SELECT id FROM staff_user WHERE id = ${observed.id}::uuid FOR UPDATE`;
      const staff = await tx.staffUser.findUnique({
        where: { id: observed.id },
      });
      if (
        !staff ||
        staff.normalizedEmail !== email ||
        staff.role !== "ADMINISTRATOR"
      )
        throw new HttpProblem(404, "NOT_FOUND");
      const rows = await tx.$queryRaw<
        { now: Date }[]
      >`SELECT clock_timestamp() AS now`;
      await tx.staffUser.update({
        where: { id: staff.id },
        data: {
          passwordHash: hash,
          mustChangePassword: false,
          temporaryCredentialExpiresAt: null,
          revision: { increment: 1 },
        },
      });
      await tx.staffSession.updateMany({
        where: { staffId: staff.id, revokedAt: null },
        data: { revokedAt: rows[0]!.now },
      });
      return staff.id;
    });
  }
}
