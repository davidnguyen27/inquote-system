import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";

export interface AppConfig {
  databaseUrl: string;
  adminOrigin: string;
  userOrigin: string;
  recoveryEpoch: string;
  csrfKey: Buffer;
  rateLimitKey: Buffer;
  operationKeys: Map<string, Buffer>;
  operationKeyId: string;
  reviewKey: Buffer;
  viewingKeys: Map<string, Buffer>;
  viewingKeyId: string;
  trustProxy: false | string[];
  host: string;
  port: number;
  apiDocsEnabled: boolean;
  opsHost?: string;
  opsPort?: number;
}
export function loadLocalEnvironment(): void {
  const file = fileURLToPath(new URL("../../.env", import.meta.url));
  if (existsSync(file)) loadEnvFile(file);
}
function required(values: NodeJS.ProcessEnv, name: string): string {
  const value = values[name];
  if (!value?.trim())
    throw new Error(`Configure ${name} before starting the server.`);
  return value;
}
function key(value: string, name: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== value)
    throw new Error(`${name} must contain a base64-encoded 32-byte key.`);
  return bytes;
}
function keyring(value: string, name: string): Map<string, Buffer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be a JSON key map.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${name} must be a JSON key map.`);
  const result = new Map<string, Buffer>();
  for (const [id, secret] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || typeof secret !== "string")
      throw new Error(`Invalid ${name} key map.`);
    result.set(id, key(secret, name));
  }
  if (!result.size) throw new Error(`${name} must not be empty.`);
  return result;
}
function origin(value: string, name: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      url.origin === value &&
      !url.username &&
      !url.password
    )
      return value;
  } catch {}
  throw new Error(`${name} must be an exact HTTPS origin.`);
}
export function databaseUrl(values: NodeJS.ProcessEnv): string {
  const value = required(values, "DATABASE_URL");
  try {
    const url = new URL(value);
    databaseSchema(url);
    if (
      ["postgres:", "postgresql:"].includes(url.protocol) &&
      url.hostname &&
      url.pathname.length > 1 &&
      decodeURIComponent(url.username) !== "YOUR_USERNAME" &&
      decodeURIComponent(url.password) !== "YOUR_PASSWORD" &&
      decodeURIComponent(url.pathname.slice(1)) !== "YOUR_DATABASE"
    )
      return value;
  } catch {}
  throw new Error(
    "Configure a valid PostgreSQL DATABASE_URL; placeholders are not runtime credentials.",
  );
}
export function databaseSchema(url: URL): string {
  const schema = url.searchParams.get("schema") ?? "public";
  if (
    !schema ||
    Buffer.byteLength(schema, "utf8") > 63 ||
    /[\u0000-\u001f\u007f]/u.test(schema)
  ) {
    throw new Error(
      "Configure a nonempty PostgreSQL schema name of at most 63 UTF-8 bytes without control characters.",
    );
  }
  return schema;
}
export function parseConfig(values: NodeJS.ProcessEnv): AppConfig {
  const csrfKey = key(required(values, "CSRF_HMAC_KEY"), "CSRF_HMAC_KEY");
  const rateLimitKey = key(
    required(values, "RATE_LIMIT_HMAC_KEY"),
    "RATE_LIMIT_HMAC_KEY",
  );
  const reviewKey = key(required(values, "REVIEW_HMAC_KEY"), "REVIEW_HMAC_KEY");
  const operationKeys = keyring(
    required(values, "OPERATION_HMAC_KEYS"),
    "OPERATION_HMAC_KEYS",
  );
  const viewingKeys = keyring(
    required(values, "VIEWING_LINK_KEYS"),
    "VIEWING_LINK_KEYS",
  );
  const operationKeyId = required(values, "OPERATION_HMAC_CURRENT_KEY_ID"),
    viewingKeyId = required(values, "VIEWING_LINK_CURRENT_KEY_ID");
  if (!operationKeys.has(operationKeyId) || !viewingKeys.has(viewingKeyId))
    throw new Error("Current key IDs must exist in their configured key maps.");
  const all = [
    csrfKey,
    rateLimitKey,
    reviewKey,
    ...operationKeys.values(),
    ...viewingKeys.values(),
  ].map((bytes) => bytes.toString("base64"));
  if (new Set(all).size !== all.length)
    throw new Error(
      "Use separate keys for each signing/encryption purpose and key ID.",
    );
  const recoveryEpoch = required(values, "RECOVERY_EPOCH").toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      recoveryEpoch,
    )
  )
    throw new Error("RECOVERY_EPOCH must be a UUID.");
  const trust = values.TRUST_PROXY ?? "false";
  const trustProxy =
    trust === "false" ? false : trust.split(",").map((value) => value.trim());
  if (
    trustProxy &&
    trustProxy.some((value) => {
      const [address, mask] = value.split("/");
      const version = isIP(address ?? "");
      return (
        value.split("/").length > 2 ||
        !version ||
        (mask !== undefined &&
          (!/^\d+$/.test(mask) || Number(mask) > (version === 4 ? 32 : 128)))
      );
    })
  )
    throw new Error(
      "TRUST_PROXY must be false or explicit trusted IP addresses/CIDRs.",
    );
  const port = Number(values.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be a valid TCP port.");
  const opsPort = Number(values.OPS_PORT ?? 3001);
  if (!Number.isInteger(opsPort) || opsPort < 1 || opsPort > 65535 || opsPort === port)
    throw new Error("OPS_PORT must be a valid TCP port separate from PORT.");
  const opsHost = values.OPS_HOST ?? "127.0.0.1";
  const address = opsHost.toLowerCase();
  const privateHost = isIP(address) === 4 ? /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)
    : isIP(address) === 6 && (address === "::1" || /^(fc|fd)[0-9a-f]{2}:/.test(address));
  if (!privateHost) throw new Error("OPS_HOST must be an explicit loopback or private IP address.");
  const apiDocs = values.ENABLE_API_DOCS ?? "false";
  if (apiDocs !== "true" && apiDocs !== "false")
    throw new Error("ENABLE_API_DOCS must be true or false.");
  const adminOrigin = origin(required(values, "ADMIN_ORIGIN"), "ADMIN_ORIGIN");
  const userOrigin = origin(required(values, "USER_ORIGIN"), "USER_ORIGIN");
  if (adminOrigin === userOrigin)
    throw new Error("Admin and User origins must be separate.");
  return {
    databaseUrl: databaseUrl(values),
    adminOrigin,
    userOrigin,
    recoveryEpoch,
    csrfKey,
    rateLimitKey,
    operationKeys,
    operationKeyId,
    reviewKey,
    viewingKeys,
    viewingKeyId,
    trustProxy,
    host: values.HOST ?? "127.0.0.1",
    port,
    apiDocsEnabled: apiDocs === "true",
    opsHost,
    opsPort,
  };
}
