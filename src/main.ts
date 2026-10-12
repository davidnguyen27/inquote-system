import { createServer, type Server } from "node:http";
import { loadLocalEnvironment, parseConfig } from "./config/env.js";
import { Database } from "./database/prisma.js";
import { createApp } from "./app.js";
import { Telemetry } from "./observability/telemetry.js";
import { createOperationsServer } from "./observability/operations-server.js";

let telemetry: Telemetry;
try {
  telemetry = new Telemetry();
} catch {
  process.stdout.write(JSON.stringify({ event: "configuration_failed", time: new Date().toISOString() }) + "\n");
  process.exit(1);
}
let config;
try {
  loadLocalEnvironment();
  config = parseConfig(process.env);
} catch {
  telemetry.lifecycle("configuration_failed");
  process.exit(1);
}

let database: Database;
try {
  database = new Database(config.databaseUrl);
} catch {
  telemetry.lifecycle("database_failed");
  process.exit(1);
}
try {
  await database.client.$connect();
} catch {
  telemetry.lifecycle("database_failed");
  await database.close().catch(() => {});
  process.exit(1);
}

let app;
try {
  app = createApp(config, database, telemetry);
} catch {
  telemetry.lifecycle("configuration_failed");
  await database.close().catch(() => {});
  process.exit(1);
}
const server = createServer(app);
const operations = createOperationsServer({ telemetry,
  readiness: () => database.checkReadiness(config), poolStats: () => database.poolStats() });
let stopping = false;
function close(listener: Server): Promise<void> {
  return new Promise(resolve => {
    if (!listener.listening) { resolve(); return; }
    listener.close(() => resolve());
    listener.closeIdleConnections();
  });
}
async function shutdown(exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  operations.stopReadiness();
  telemetry.lifecycle("stopping");
  const deadline = setTimeout(() => { telemetry.lifecycle("shutdown_timeout"); process.exit(1); }, 10000);
  deadline.unref();
  try {
    await Promise.all([close(server), close(operations)]);
    await database.close();
    telemetry.lifecycle("stopped");
    clearTimeout(deadline);
    process.exit(exitCode);
  } catch {
    telemetry.lifecycle("shutdown_failed");
    process.exit(1);
  }
}
function listen(listener: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, host, () => { listener.off("error", reject); resolve(); });
  });
}
for (const listener of [server, operations]) listener.on("error", () => {
  telemetry.lifecycle("listener_failed");
  void shutdown(1);
});
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
try {
  // Sequential startup makes a failed private bind close the already-open business listener.
  await listen(server, config.port, config.host);
  await listen(operations, config.opsPort ?? 3001, config.opsHost ?? "127.0.0.1");
  telemetry.lifecycle("started");
} catch {
  await shutdown(1);
}
