-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- Archive the 1-100000 reservation outside PostgreSQL before enabling creation.
-- Operators alone may raise the bound; lossy recovery skips reserved ranges.
CREATE SEQUENCE quotation_reference_seq AS BIGINT
  MINVALUE 1 MAXVALUE 100000 START WITH 1 INCREMENT BY 1 CACHE 1 NO CYCLE;

CREATE FUNCTION next_quotation_reference() RETURNS TEXT
LANGUAGE sql VOLATILE AS $$
  SELECT 'IQ-' || lpad(value::text, greatest(6, length(value::text)), '0')
  FROM (SELECT nextval('quotation_reference_seq') AS value) AS allocation;
$$;

-- CreateEnum
CREATE TYPE "staff_role" AS ENUM ('ADMINISTRATOR', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "quotation_version_state" AS ENUM ('DRAFT', 'SHARED');

-- CreateTable
CREATE TABLE "staff_user" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "display_name" VARCHAR(200) NOT NULL,
    "normalized_email" VARCHAR(254) NOT NULL,
    "role" "staff_role" NOT NULL DEFAULT 'EMPLOYEE',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "password_hash" TEXT NOT NULL,
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "temporary_credential_expires_at" TIMESTAMPTZ(3),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "staff_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "recovery_epoch" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "staff_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_profile" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "display_name" VARCHAR(200),
    "address" VARCHAR(500),
    "phone" VARCHAR(50),
    "email" VARCHAR(254),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_item" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(500),
    "unit" VARCHAR(50) NOT NULL,
    "unit_price_vnd" BIGINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reference" TEXT NOT NULL DEFAULT next_quotation_reference(),
    "owner_id" UUID NOT NULL,
    "last_allocated_number" INTEGER NOT NULL DEFAULT 1,
    "latest_shared_version_id" UUID,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "discarded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "summary_customer_name" VARCHAR(200),
    "summary_work_description" VARCHAR(200),
    "summary_total_vnd" BIGINT,

    CONSTRAINT "quotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_version" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "quotation_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "state" "quotation_version_state" NOT NULL DEFAULT 'DRAFT',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "content" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shared_at" TIMESTAMPTZ(3),

    CONSTRAINT "quotation_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "viewing_access" (
    "quotation_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "generation" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "token_ciphertext" BYTEA,
    "token_nonce" BYTEA,
    "token_tag" BYTEA,
    "encryption_key_id" TEXT,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "viewing_access_pkey" PRIMARY KEY ("quotation_id")
);

-- CreateTable
CREATE TABLE "operation_receipt" (
    "actor_id" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "fingerprint" BYTEA NOT NULL,
    "fingerprint_key_id" TEXT NOT NULL,
    "recovery_epoch" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "method" VARCHAR(10) NOT NULL,
    "route" TEXT NOT NULL,
    "target" JSONB NOT NULL,
    "resource_ids" JSONB NOT NULL,
    "applied_revisions" JSONB NOT NULL,
    "access_generation" UUID,
    "committed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "operation_receipt_pkey" PRIMARY KEY ("actor_id","idempotency_key")
);

-- CreateTable
CREATE TABLE "rate_limit_bucket" (
    "scope" TEXT NOT NULL,
    "key_digest" BYTEA NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_limit_bucket_pkey" PRIMARY KEY ("scope","key_digest","window_start")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_user_normalized_email_key" ON "staff_user"("normalized_email");

-- CreateIndex
CREATE UNIQUE INDEX "staff_session_token_hash_key" ON "staff_session"("token_hash");

-- CreateIndex
CREATE INDEX "staff_session_staff_id_revoked_at_idx" ON "staff_session"("staff_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_reference_key" ON "quotation"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_id_latest_shared_version_id_key" ON "quotation"("id", "latest_shared_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_version_quotation_id_number_key" ON "quotation_version"("quotation_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_version_quotation_id_id_key" ON "quotation_version"("quotation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "viewing_access_token_hash_key" ON "viewing_access"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "viewing_access_quotation_id_version_id_key" ON "viewing_access"("quotation_id", "version_id");

-- CreateIndex
CREATE INDEX "rate_limit_bucket_expires_at_idx" ON "rate_limit_bucket"("expires_at");

-- AddForeignKey
ALTER TABLE "staff_session" ADD CONSTRAINT "staff_session_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "staff_user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_id_latest_shared_version_id_fkey" FOREIGN KEY ("id", "latest_shared_version_id") REFERENCES "quotation_version"("quotation_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quotation_version" ADD CONSTRAINT "quotation_version_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "viewing_access" ADD CONSTRAINT "viewing_access_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "viewing_access" ADD CONSTRAINT "viewing_access_quotation_id_version_id_fkey" FOREIGN KEY ("quotation_id", "version_id") REFERENCES "quotation_version"("quotation_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "operation_receipt" ADD CONSTRAINT "operation_receipt_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "staff_user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- PostgreSQL business guards not representable as ordinary Prisma model fields.
ALTER TABLE staff_user
  ADD CONSTRAINT staff_user_revision_positive CHECK (revision > 0),
  ADD CONSTRAINT staff_user_name_nonblank CHECK (btrim(display_name) <> ''),
  ADD CONSTRAINT staff_user_email_normalized CHECK (normalized_email = lower(btrim(normalized_email)) AND normalized_email <> ''),
  ADD CONSTRAINT staff_user_temporary_credential_consistent CHECK (
    (must_change_password AND temporary_credential_expires_at IS NOT NULL)
    OR (NOT must_change_password AND temporary_credential_expires_at IS NULL)
  );

ALTER TABLE staff_session
  ADD CONSTRAINT staff_session_hash_length CHECK (octet_length(token_hash) = 32),
  ADD CONSTRAINT staff_session_times_valid CHECK (
    absolute_expires_at > created_at AND last_seen_at >= created_at AND last_seen_at <= absolute_expires_at
  );

ALTER TABLE company_profile
  ADD CONSTRAINT company_profile_singleton CHECK (id = 1),
  ADD CONSTRAINT company_profile_revision_positive CHECK (revision > 0);
INSERT INTO company_profile (id) VALUES (1);

ALTER TABLE catalog_item
  ADD CONSTRAINT catalog_item_revision_positive CHECK (revision > 0),
  ADD CONSTRAINT catalog_item_name_nonblank CHECK (btrim(name) <> ''),
  ADD CONSTRAINT catalog_item_unit_nonblank CHECK (btrim(unit) <> ''),
  ADD CONSTRAINT catalog_item_price_bounds CHECK (unit_price_vnd BETWEEN 0 AND 1000000000000);

ALTER TABLE quotation
  ADD CONSTRAINT quotation_revision_positive CHECK (revision > 0),
  ADD CONSTRAINT quotation_allocation_positive CHECK (last_allocated_number > 0),
  ADD CONSTRAINT quotation_reference_format CHECK (reference ~ '^IQ-[0-9]{6,}$'),
  ADD CONSTRAINT quotation_summary_total_bounds CHECK (summary_total_vnd BETWEEN 0 AND 1000000000000000),
  ADD CONSTRAINT quotation_discarded_not_shared CHECK (discarded_at IS NULL OR latest_shared_version_id IS NULL);

ALTER TABLE quotation_version
  ADD CONSTRAINT quotation_version_number_positive CHECK (number > 0),
  ADD CONSTRAINT quotation_version_revision_positive CHECK (revision > 0),
  ADD CONSTRAINT quotation_version_schema_positive CHECK (schema_version > 0),
  ADD CONSTRAINT quotation_version_content_object CHECK (jsonb_typeof(content) = 'object'),
  ADD CONSTRAINT quotation_version_shared_at_consistent CHECK (
    (state = 'DRAFT' AND shared_at IS NULL) OR (state = 'SHARED' AND shared_at IS NOT NULL)
  );

CREATE UNIQUE INDEX quotation_version_one_draft_idx ON quotation_version (quotation_id)
  WHERE state = 'DRAFT';
CREATE INDEX quotation_owner_updated_visible_idx ON quotation (owner_id, updated_at, id)
  WHERE discarded_at IS NULL;
CREATE INDEX quotation_updated_visible_idx ON quotation (updated_at, id)
  WHERE discarded_at IS NULL;

ALTER TABLE viewing_access
  ADD CONSTRAINT viewing_access_revision_positive CHECK (revision > 0),
  ADD CONSTRAINT viewing_access_hash_length CHECK (octet_length(token_hash) = 32),
  ADD CONSTRAINT viewing_access_expiry CHECK (expires_at = issued_at + interval '720 hours'),
  ADD CONSTRAINT viewing_access_encrypted_bundle CHECK (
    num_nonnulls(token_ciphertext, token_nonce, token_tag, encryption_key_id) IN (0, 4)
  ),
  ADD CONSTRAINT viewing_access_encrypted_lengths CHECK (
    octet_length(token_ciphertext) = 32 AND octet_length(token_nonce) = 12 AND octet_length(token_tag) = 16
  ),
  ADD CONSTRAINT viewing_access_revoked_no_ciphertext CHECK (revoked_at IS NULL OR token_ciphertext IS NULL);

ALTER TABLE operation_receipt
  ADD CONSTRAINT operation_receipt_fingerprint_length CHECK (octet_length(fingerprint) = 32),
  ADD CONSTRAINT operation_receipt_target_object CHECK (jsonb_typeof(target) = 'object'),
  ADD CONSTRAINT operation_receipt_resources_object CHECK (jsonb_typeof(resource_ids) = 'object'),
  ADD CONSTRAINT operation_receipt_revisions_object CHECK (jsonb_typeof(applied_revisions) = 'object');

ALTER TABLE rate_limit_bucket
  ADD CONSTRAINT rate_limit_bucket_count_nonnegative CHECK (count >= 0),
  ADD CONSTRAINT rate_limit_bucket_digest_nonempty CHECK (octet_length(key_digest) > 0),
  ADD CONSTRAINT rate_limit_bucket_window_valid CHECK (expires_at > window_start);

CREATE FUNCTION guard_quotation_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'SHARED' THEN
    RAISE EXCEPTION 'Shared quotation versions are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.id <> OLD.id OR NEW.quotation_id <> OLD.quotation_id OR NEW.number <> OLD.number THEN
    RAISE EXCEPTION 'Quotation version identity and number are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER quotation_version_immutable_guard
  BEFORE UPDATE OR DELETE ON quotation_version
  FOR EACH ROW EXECUTE FUNCTION guard_quotation_version();

CREATE FUNCTION guard_quotation_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Discard quotations by retaining their allocation anchor' USING ERRCODE = '23514';
  END IF;
  IF NEW.id <> OLD.id OR NEW.owner_id <> OLD.owner_id OR NEW.reference <> OLD.reference THEN
    RAISE EXCEPTION 'Quotation identity, reference and owner are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.last_allocated_number < OLD.last_allocated_number THEN
    RAISE EXCEPTION 'Allocated version numbers cannot be reclaimed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER quotation_identity_guard
  BEFORE UPDATE OR DELETE ON quotation
  FOR EACH ROW EXECUTE FUNCTION guard_quotation_identity();

-- Services still enforce JSON schema/calculation, trusted catalog copies, ownership,
-- latest-SHARED access, captured recovery epoch, review binding and transaction order.
