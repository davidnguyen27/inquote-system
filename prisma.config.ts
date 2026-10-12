import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { defineConfig, env } from "prisma/config";

const envFile = fileURLToPath(new URL(".env", import.meta.url));
if (existsSync(envFile)) loadEnvFile(envFile);

const databaseUrl = env("DATABASE_URL");
if (!databaseUrl.trim()) {
  throw new Error("DATABASE_URL must not be empty. Configure server/.env.");
}

// Validation and schema diffs require a URL but do not connect to the database.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: databaseUrl },
});
