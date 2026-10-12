import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { RequestHandler } from "express";

const methods = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]);
const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
type Lifecycle = "started" | "stopping" | "stopped" | "configuration_failed" | "database_failed" | "listener_failed" | "shutdown_failed" | "shutdown_timeout";
type Observation = { count: number; sum: number; buckets: number[] };
export type PoolStats = { total: number; idle: number; waiting: number };

export class Telemetry {
  private readonly routes: Set<string>;
  private readonly observations = new Map<string, Observation>();
  private active = 0;

  constructor(private readonly write: (line: string) => void = line => process.stdout.write(line + "\n")) {
    const contract = JSON.parse(readFileSync(new URL("../../openapi/auth.openapi.json", import.meta.url), "utf8")) as { paths: Record<string, unknown> };
    this.routes = new Set(Object.keys(contract.paths).map(path => "/api/v1" + path.replace(/\{([a-zA-Z]+)\}/g, ":$1")));
    for (const path of ["/", "/openapi.json", "/docs/"]) this.routes.add(path);
  }

  private log(record: object): void {
    // A failing output sink must not change a completed business operation.
    try { this.write(JSON.stringify(record)); } catch {}
  }

  lifecycle(event: Lifecycle): void {
    this.log({ event, time: new Date().toISOString() });
  }

  readonly middleware: RequestHandler = (req, res, next) => {
    const start = performance.now();
    this.active++;
    let recorded = false;
    const record = (completed: boolean) => {
      if (recorded) return;
      recorded = true;
      this.active--;
      const registered: unknown = req.route?.path;
      const candidate = typeof registered === "string" ? "/api/v1" + registered : "";
      const route = this.routes.has(candidate) ? candidate : typeof registered === "string" && this.routes.has(registered) ? registered : "unmatched";
      const method = methods.has(req.method) ? req.method : "OTHER";
      const status = completed ? String(res.statusCode) : "aborted";
      const duration = Math.max(0, (performance.now() - start) / 1000);
      const labels = `route="${route}",method="${method}",status="${status}"`;
      let observation = this.observations.get(labels);
      if (!observation) {
        observation = { count: 0, sum: 0, buckets: buckets.map(() => 0) };
        this.observations.set(labels, observation);
      }
      observation.count++;
      observation.sum += duration;
      buckets.forEach((bound, index) => { if (duration <= bound) observation.buckets[index]!++; });
      this.log({ event: "request", time: new Date().toISOString(), requestId: res.locals.requestId,
        method, route, status: completed ? res.statusCode : "aborted", durationMs: Math.round(duration * 1000000) / 1000 });
    };
    res.once("finish", () => record(true));
    res.once("close", () => record(false));
    next();
  };

  metrics(pool?: PoolStats): string {
    const lines = ["# TYPE inquote_http_requests_total counter", "# TYPE inquote_http_request_duration_seconds histogram"];
    for (const [labels, observation] of this.observations) {
      lines.push(`inquote_http_requests_total{${labels}} ${observation.count}`);
      buckets.forEach((bound, index) => lines.push(`inquote_http_request_duration_seconds_bucket{${labels},le="${bound}"} ${observation.buckets[index]}`));
      lines.push(`inquote_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${observation.count}`,
        `inquote_http_request_duration_seconds_sum{${labels}} ${observation.sum}`,
        `inquote_http_request_duration_seconds_count{${labels}} ${observation.count}`);
    }
    const memory = process.memoryUsage(), cpu = process.cpuUsage();
    const gauges: Record<string, number> = { http_requests_in_flight: this.active,
      process_resident_memory_bytes: memory.rss, process_heap_used_bytes: memory.heapUsed, process_uptime_seconds: process.uptime() };
    if (pool) Object.assign(gauges, { db_pool_connections: pool.total, db_pool_idle_connections: pool.idle,
      db_pool_busy_connections: pool.total - pool.idle, db_pool_waiting_requests: pool.waiting });
    for (const [name, value] of Object.entries(gauges)) lines.push(`# TYPE inquote_${name} gauge`, `inquote_${name} ${value}`);
    lines.push("# TYPE inquote_process_cpu_seconds_total counter", `inquote_process_cpu_seconds_total ${(cpu.user + cpu.system) / 1000000}`);
    return lines.join("\n") + "\n";
  }
}
