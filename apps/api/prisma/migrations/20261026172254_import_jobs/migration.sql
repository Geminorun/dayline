BEGIN;
CREATE TABLE "import_jobs" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK ("kind" IN ('guest','csv','json')),
  "client_operation_id" uuid NOT NULL,
  "input_digest" text NOT NULL,
  "auth_epoch" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'preview' CHECK ("status" IN ('preview','committed','cancelled','expired')),
  "input" jsonb,
  "plan" jsonb NOT NULL,
  "receipt" jsonb,
  "expires_at" timestamptz(3) NOT NULL,
  "created_at" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" timestamptz(3),
  UNIQUE ("user_id", "client_operation_id")
);
CREATE INDEX "import_jobs_user_id_input_digest_idx" ON "import_jobs"("user_id", "input_digest");
CREATE INDEX "import_jobs_status_expires_at_idx" ON "import_jobs"("status", "expires_at");
COMMIT;
