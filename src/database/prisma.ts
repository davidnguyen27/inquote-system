import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "../generated/prisma/client.js";
import { HttpProblem } from "../http/problem.js";
import { databaseSchema, type AppConfig } from "../config/env.js";
import { Pool } from "pg";
import { checkReadiness } from "../observability/readiness.js";

export class Database {
  readonly client: PrismaClient;
  private readonly pool: Pool;
  private readonly schema: string;

  constructor(url: string) {
    // The adapter's timestamptz parser expects UTC text; enforce it for every pooled connection.
    const connection = new URL(url);
    const schema = databaseSchema(connection);
    this.schema = schema;
    // Quote the SQL identifier, then escape PostgreSQL startup-option token separators.
    const searchPath = `pg_catalog,"${schema.replace(/"/g, '""')}"`.replace(
      /[\\\s]/gu,
      (value) => `\\${value}`,
    );
    connection.searchParams.set(
      "options",
      `${connection.searchParams.get("options") ?? ""} -c timezone=UTC -c search_path=${searchPath}`.trim(),
    );
    this.pool = new Pool({ connectionString: connection.toString(), connectionTimeoutMillis: 2000 });
    this.client = new PrismaClient({
      adapter: new PrismaPg(
        this.pool,
        { schema, disposeExternalPool: true },
      ),
      errorFormat: "minimal",
    });
  }

  async close(): Promise<void> {
    try { await this.client.$disconnect(); }
    finally { if (!this.pool.ended && !this.pool.ending) await this.pool.end(); }
  }

  poolStats() {
    return { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount };
  }

  checkReadiness(config: AppConfig): Promise<boolean> {
    return checkReadiness(this.pool, this.schema, config);
  }

  async transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.$transaction(work, {
          isolationLevel: "ReadCommitted",
          maxWait: 5000,
          timeout: 10000,
        });
      } catch (error) {
        const driver =
          error instanceof Prisma.PrismaClientKnownRequestError
            ? error.meta?.driverAdapterError
            : undefined;
        const cause =
          driver && typeof driver === "object" && "cause" in driver
            ? driver.cause
            : undefined;
        const originalCode =
          cause && typeof cause === "object" && "originalCode" in cause
            ? cause.originalCode
            : undefined;
        const retry =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === "P2034" ||
            (error.code === "P2010" &&
              ["40001", "40P01"].includes(
                String(error.meta?.code ?? originalCode),
              )));
        if (!retry) throw error;
        if (attempt === 2) throw new HttpProblem(503, "SERVICE_UNAVAILABLE");
        await new Promise((resolve) =>
          setTimeout(resolve, 20 + Math.random() * 40),
        );
      }
    }
  }
}
