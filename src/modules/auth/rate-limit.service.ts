import { createHmac } from "node:crypto";
import { Database } from "../../database/prisma.js";
import { RateLimitProblem } from "../../http/problem.js";

export class RateLimitService {
  private lastCleanup = 0;
  constructor(
    private readonly database: Database,
    private readonly key: Buffer,
  ) {}
  async consumeSession(digest: Uint8Array<ArrayBuffer>): Promise<void> {
    const session = await this.database.client.staffSession.findUnique({
      where: { tokenHash: digest }, select: { id: true },
    });
    if (!session) return;
    await this.consume([{ scope: "staff_session", identity: Buffer.from(digest).toString("hex"), limit: 300, seconds: 60 }]);
  }
  async consume(
    policies: {
      scope: string;
      identity: string;
      limit: number;
      seconds: number;
    }[],
  ): Promise<void> {
    const result = await this.database.transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { now: Date }[]
      >`SELECT clock_timestamp() AS now`;
      const now = rows[0]!.now;
      let retryAfter = 0;
      for (const policy of policies) {
        const start = new Date(
          Math.floor(now!.getTime() / (policy.seconds * 1000)) *
            policy.seconds *
            1000,
        );
        const end = new Date(start.getTime() + policy.seconds * 1000);
        const digest = createHmac("sha256", this.key)
          .update(JSON.stringify([policy.scope, policy.identity]))
          .digest();
        const rows = await tx.$queryRaw<{ count: number }[]>`
          INSERT INTO rate_limit_bucket (scope, key_digest, window_start, count, expires_at)
          VALUES (${policy.scope}, ${digest}, ${start}, 1, ${end})
          ON CONFLICT (scope, key_digest, window_start) DO UPDATE
          SET count = LEAST(rate_limit_bucket.count + 1, ${policy.limit + 1}) RETURNING count`;
        if (rows[0]!.count > policy.limit)
          retryAfter = Math.max(
            retryAfter,
            Math.ceil((end.getTime() - now!.getTime()) / 1000),
          );
      }
      return { retryAfter, now: now! };
    });
    if (result.now.getTime() - this.lastCleanup >= 60000) {
      this.lastCleanup = result.now.getTime();
      await this.database.client.rateLimitBucket.deleteMany({
        where: { expiresAt: { lte: result.now } },
      });
    }
    if (result.retryAfter) throw new RateLimitProblem(result.retryAfter);
  }
}
