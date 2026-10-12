import type { Pool } from "pg";
import type { AppConfig } from "../config/env.js";

// Required v1 columns include private fields, but probes return only a boolean.
const columns: Record<string, string> = {
  staff_user: "id display_name normalized_email role enabled password_hash must_change_password temporary_credential_expires_at revision created_at updated_at",
  staff_session: "id staff_id token_hash recovery_epoch created_at last_seen_at absolute_expires_at revoked_at",
  company_profile: "id display_name address phone email revision created_at updated_at",
  catalog_item: "id name description unit unit_price_vnd active revision created_at updated_at",
  quotation: "id reference owner_id last_allocated_number latest_shared_version_id revision discarded_at created_at updated_at summary_customer_name summary_work_description summary_total_vnd",
  quotation_version: "id quotation_id number state revision schema_version content created_at updated_at shared_at",
  viewing_access: "quotation_id version_id generation token_hash token_ciphertext token_nonce token_tag encryption_key_id issued_at expires_at revoked_at revision",
  operation_receipt: "actor_id idempotency_key fingerprint fingerprint_key_id recovery_epoch kind method route target resource_ids applied_revisions access_generation committed_at",
  rate_limit_bucket: "scope key_digest window_start count expires_at",
};

export async function checkReadiness(pool: Pool, schema: string, config: AppConfig): Promise<boolean> {
  if (!config.recoveryEpoch || !config.operationKeys.has(config.operationKeyId) || !config.viewingKeys.has(config.viewingKeyId) ||
    [config.csrfKey, config.rateLimitKey, config.reviewKey, ...config.operationKeys.values(), ...config.viewingKeys.values()].some(key => key.length !== 32)) return false;
  const client = await pool.connect();
  let healthy = false;
  let broken = false;
  const onError = () => { broken = true; };
  const cleanup = () => {
    client.off("error", onError);
    client.off("end", cleanup);
  };
  client.on("error", onError);
  client.once("end", cleanup);
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '1000ms'");
    await client.query("SET LOCAL lock_timeout = '500ms'");
    const quotedSchema = '"' + schema.replace(/"/g, '""') + '"';
    for (const [table, names] of Object.entries(columns)) {
      await client.query(`SELECT ${names.split(" ").map(name => '"' + name + '"').join(",")} FROM ${quotedSchema}."${table}" LIMIT 0`);
    }
    const guards = await client.query<{ compatible: boolean }>(`
      SELECT
        (SELECT count(*) = 2 FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND t.tgenabled IN ('O','A') AND
            ((c.relname = 'quotation_version' AND t.tgname = 'quotation_version_immutable_guard') OR
             (c.relname = 'quotation' AND t.tgname = 'quotation_identity_guard')))
        AND EXISTS (SELECT 1 FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = 'quotation_version_one_draft_idx'
            AND i.indisunique AND i.indisvalid AND i.indpred IS NOT NULL)
        AS compatible`, [schema]);
    if (!guards.rows[0]?.compatible) return false;
    const content = await client.query<{ compatible: boolean }>(`
      SELECT NOT EXISTS (SELECT 1 FROM ${quotedSchema}.quotation_version WHERE schema_version <> 1)
        AND NOT EXISTS (SELECT 1 FROM ${quotedSchema}.operation_receipt WHERE NOT (fingerprint_key_id = ANY($1::text[])))
        AND NOT EXISTS (SELECT 1 FROM ${quotedSchema}.viewing_access
          WHERE revoked_at IS NULL AND expires_at > clock_timestamp() AND token_ciphertext IS NOT NULL
            AND (encryption_key_id IS NULL OR NOT (encryption_key_id = ANY($2::text[])))) AS compatible`,
      [[...config.operationKeys.keys()], [...config.viewingKeys.keys()]]);
    const compatible = content.rows[0]?.compatible === true;
    await client.query("COMMIT");
    healthy = true;
    return compatible && !broken;
  } finally {
    // Destroy incomplete transactions rather than letting a failed probe poison a pooled connection.
    const discard = broken || !healthy;
    client.release(discard);
    // A normal release restores the pool's idle handler; discarded clients need coverage until end.
    if (!discard) cleanup();
  }
}
