import { createServer } from "node:http";
import type { PoolStats, Telemetry } from "./telemetry.js";

export function createOperationsServer(options: {
  telemetry: Telemetry;
  readiness: () => Promise<boolean>;
  poolStats?: () => PoolStats;
  timeoutMs?: number;
}) {
  let pending: Promise<boolean> | undefined;
  let stopping = false;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const path = req.url?.split("?", 1)[0];
    if (req.method !== "GET" || !["/_ops/live", "/_ops/ready", "/_ops/metrics"].includes(path ?? "")) {
      res.writeHead(404, { "Content-Type": "application/json" }).end('{"status":"unavailable"}');
      return;
    }
    if (path === "/_ops/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" }).end(options.telemetry.metrics(options.poolStats?.()));
      return;
    }
    let ready = !stopping;
    if (path === "/_ops/ready" && ready) {
      // Keep timed-out work single-flight until its underlying database check settles.
      if (!pending) pending = Promise.resolve().then(options.readiness).catch(() => false).finally(() => { pending = undefined; });
      let timer: NodeJS.Timeout | undefined;
      ready = await Promise.race([pending, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), options.timeoutMs ?? 2500); })]);
      if (timer) clearTimeout(timer);
      ready &&= !stopping;
    }
    res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" }).end(JSON.stringify({ status: ready ? path === "/_ops/live" ? "live" : "ready" : "unavailable" }));
  });
  return Object.assign(server, { stopReadiness: () => { stopping = true; } });
}
