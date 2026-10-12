\set ON_ERROR_STOP on
BEGIN;

DO $$
BEGIN
  ASSERT to_regclass('quotation_version') IS NOT NULL,
    'Missing quotation version schema: apply the initial migration to an isolated test database';
END;
$$;

CREATE FUNCTION pg_temp.expect_failure(statement text, expected_state text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  rejected boolean := false;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> expected_state THEN
      RAISE EXCEPTION 'Expected SQLSTATE %, got %: %', expected_state, SQLSTATE, SQLERRM;
    END IF;
    rejected := true;
  END;
  ASSERT rejected, format('Expected rejection: %s', statement);
END;
$$;

INSERT INTO staff_user (id, display_name, normalized_email, role, password_hash)
VALUES ('10000000-0000-4000-8000-000000000001', 'Synthetic staff', 'staff@example.test', 'EMPLOYEE', 'NOT-A-USABLE-PASSWORD-HASH');

UPDATE company_profile SET display_name = 'Synthetic Interiors' WHERE id = 1;
SELECT pg_temp.expect_failure('INSERT INTO company_profile (id) VALUES (2)', '23514');
SELECT pg_temp.expect_failure($test$
  INSERT INTO catalog_item (name, unit, unit_price_vnd) VALUES ('Too expensive', 'm', 1000000000001)
$test$, '23514');
INSERT INTO catalog_item (name, unit, unit_price_vnd) VALUES ('Zero price permitted', 'm', 0);

INSERT INTO quotation (id, owner_id)
VALUES ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001'),
       ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001');

INSERT INTO quotation_version (id, quotation_id, number, content)
VALUES ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 1, '{"currency":"VND"}'),
       ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 1, '{"currency":"VND"}');

SELECT pg_temp.expect_failure($test$
  INSERT INTO quotation_version (quotation_id, number, content)
  VALUES ('20000000-0000-4000-8000-000000000001', 2, '{}')
$test$, '23505');
SELECT pg_temp.expect_failure($test$
  UPDATE quotation SET latest_shared_version_id = '30000000-0000-4000-8000-000000000002'
  WHERE id = '20000000-0000-4000-8000-000000000001'
$test$, '23503');

UPDATE quotation_version SET state = 'SHARED', shared_at = clock_timestamp(), revision = revision + 1
WHERE id = '30000000-0000-4000-8000-000000000001';
UPDATE quotation SET latest_shared_version_id = '30000000-0000-4000-8000-000000000001', last_allocated_number = 2
WHERE id = '20000000-0000-4000-8000-000000000001';

SELECT pg_temp.expect_failure($test$
  UPDATE quotation_version SET content = '{"currency":"CHANGED"}'
  WHERE id = '30000000-0000-4000-8000-000000000001'
$test$, '23514');
SELECT pg_temp.expect_failure($test$
  DELETE FROM quotation_version WHERE id = '30000000-0000-4000-8000-000000000001'
$test$, '23514');
SELECT pg_temp.expect_failure($test$
  UPDATE quotation SET last_allocated_number = 1 WHERE id = '20000000-0000-4000-8000-000000000001'
$test$, '23514');
SELECT pg_temp.expect_failure($test$
  UPDATE quotation SET reference = 'IQ-CHANGED' WHERE id = '20000000-0000-4000-8000-000000000001'
$test$, '23514');
SELECT pg_temp.expect_failure($test$
  DELETE FROM quotation WHERE id = '20000000-0000-4000-8000-000000000001'
$test$, '23514');
SELECT pg_temp.expect_failure($test$
  UPDATE quotation_version SET number = 2 WHERE id = '30000000-0000-4000-8000-000000000002'
$test$, '23514');

INSERT INTO quotation_version (id, quotation_id, number, content)
VALUES ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', 2, '{}');
DELETE FROM quotation_version WHERE id = '30000000-0000-4000-8000-000000000003';
DO $$ BEGIN
  ASSERT (SELECT last_allocated_number = 2 FROM quotation WHERE id = '20000000-0000-4000-8000-000000000001'),
    'Discard must preserve the allocated version counter';
END; $$;

INSERT INTO viewing_access (quotation_id, version_id, generation, token_hash, token_ciphertext, token_nonce, token_tag, encryption_key_id, issued_at, expires_at)
VALUES ('20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001', decode(repeat('01', 32), 'hex'), decode(repeat('02', 32), 'hex'),
  decode(repeat('03', 12), 'hex'), decode(repeat('04', 16), 'hex'), 'SYNTHETIC-KEY-ID',
  '2026-10-10 09:00:00+00', '2026-11-09 09:00:00+00');
SELECT pg_temp.expect_failure($test$
  UPDATE viewing_access SET version_id = '30000000-0000-4000-8000-000000000002'
  WHERE quotation_id = '20000000-0000-4000-8000-000000000001'
$test$, '23503');
SELECT pg_temp.expect_failure($test$
  UPDATE viewing_access SET expires_at = issued_at + interval '719 hours'
  WHERE quotation_id = '20000000-0000-4000-8000-000000000001'
$test$, '23514');
SELECT pg_temp.expect_failure($test$
  UPDATE viewing_access SET revoked_at = clock_timestamp()
  WHERE quotation_id = '20000000-0000-4000-8000-000000000001'
$test$, '23514');
UPDATE viewing_access SET revoked_at = clock_timestamp(), token_ciphertext = NULL,
  token_nonce = NULL, token_tag = NULL, encryption_key_id = NULL, revision = revision + 1
WHERE quotation_id = '20000000-0000-4000-8000-000000000001';

INSERT INTO operation_receipt (actor_id, idempotency_key, fingerprint, fingerprint_key_id, recovery_epoch,
  kind, method, route, target, resource_ids, applied_revisions, committed_at)
VALUES ('10000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001',
  decode(repeat('05', 32), 'hex'), 'SYNTHETIC-HMAC-KEY-ID', '60000000-0000-4000-8000-000000000001',
  'DISCARD_DRAFT', 'DELETE', '/quotations/{q}/versions/{v}/draft',
  '{"quotationId":"20000000-0000-4000-8000-000000000001"}',
  '{"versionId":"30000000-0000-4000-8000-000000000003"}', '{}', clock_timestamp());
SELECT pg_temp.expect_failure($test$
  INSERT INTO operation_receipt SELECT * FROM operation_receipt
$test$, '23505');
SELECT pg_temp.expect_failure($test$
  DELETE FROM staff_user WHERE id = '10000000-0000-4000-8000-000000000001'
$test$, '23503');

DO $$ BEGIN
  ASSERT (SELECT count(*) = 1 FROM operation_receipt), 'Successful receipt must survive draft deletion';
  ASSERT (SELECT state = 'SHARED' FROM quotation_version WHERE id = '30000000-0000-4000-8000-000000000001'),
    'Revoking access must not change the shared snapshot';
END; $$;

-- Larger independently reserved ranges must retain every reference digit.
ALTER SEQUENCE quotation_reference_seq MAXVALUE 2000000;
SELECT setval('quotation_reference_seq', 1000000, false);
DO $$ BEGIN
  ASSERT next_quotation_reference() = 'IQ-1000000', 'Reference padding must not truncate seven-digit values';
END; $$;

ROLLBACK;
\echo 'Prisma migration invariants passed; synthetic rows rolled back (sequence gaps are expected).'
