BEGIN;
-- AlterTable
ALTER TABLE "users" ADD COLUMN     "merged_into_user_id" UUID;

-- AlterTable
ALTER TABLE "qr_requests" ADD COLUMN     "action_context" JSONB,
ADD COLUMN     "initiator_auth_epoch" INTEGER,
ADD COLUMN     "initiator_session_id" UUID,
ADD COLUMN     "initiator_user_id" UUID,
ADD COLUMN     "result" JSONB;

-- CreateTable
CREATE TABLE "email_binding_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "auth_epoch" INTEGER NOT NULL,
    "operation_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_binding_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merge_contexts" (
    "id" UUID NOT NULL,
    "initiator_user_id" UUID NOT NULL,
    "other_user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "initiator_epoch" INTEGER NOT NULL,
    "other_epoch" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merge_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_merges" (
    "id" UUID NOT NULL,
    "initiator_user_id" UUID NOT NULL,
    "source_user_id" UUID NOT NULL,
    "target_user_id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "context_id" UUID NOT NULL,
    "source_epoch" INTEGER NOT NULL,
    "target_epoch" INTEGER NOT NULL,
    "source_data_version" BIGINT NOT NULL,
    "target_data_version" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'preview',
    "plan" JSONB NOT NULL,
    "recovery_snapshot" JSONB,
    "recovery_expires_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_merges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merge_record_mappings" (
    "merge_id" UUID NOT NULL,
    "mappings" JSONB NOT NULL,

    CONSTRAINT "merge_record_mappings_pkey" PRIMARY KEY ("merge_id")
);

-- CreateIndex
CREATE INDEX "email_binding_requests_status_expires_at_idx" ON "email_binding_requests"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_binding_requests_user_id_operation_id_key" ON "email_binding_requests"("user_id", "operation_id");

-- CreateIndex
CREATE INDEX "merge_contexts_initiator_user_id_operation_id_idx" ON "merge_contexts"("initiator_user_id", "operation_id");

-- CreateIndex
CREATE INDEX "account_merges_target_user_id_status_idx" ON "account_merges"("target_user_id", "status");

-- CreateIndex
CREATE INDEX "account_merges_source_user_id_status_idx" ON "account_merges"("source_user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "account_merges_initiator_user_id_operation_id_key" ON "account_merges"("initiator_user_id", "operation_id");

COMMIT;
