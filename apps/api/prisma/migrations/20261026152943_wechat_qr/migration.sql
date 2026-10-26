CREATE TABLE "wechat_identities" (
  "id" UUID NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "app_id" TEXT NOT NULL, "openid" TEXT NOT NULL, "unionid" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "wechat_identities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "wechat_identities_app_id_openid_key" ON "wechat_identities"("app_id", "openid");
CREATE UNIQUE INDEX "wechat_identities_user_id_app_id_key" ON "wechat_identities"("user_id", "app_id");
CREATE TABLE "qr_requests" (
  "id" UUID NOT NULL PRIMARY KEY, "purpose" TEXT NOT NULL CHECK ("purpose" IN ('login', 'bind_wechat')),
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'scanned', 'confirmed', 'consumed', 'cancelled', 'expired')),
  "browser_secret_hash" TEXT NOT NULL, "scene_hash" TEXT NOT NULL,
  "scanner_secret_hash" TEXT, "scanner_app_id" TEXT, "scanner_openid" TEXT, "scanner_unionid" TEXT,
  "confirmed_user_id" UUID,
  "expires_at" TIMESTAMPTZ(3) NOT NULL, "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL
);
CREATE UNIQUE INDEX "qr_requests_scene_hash_key" ON "qr_requests"("scene_hash");
CREATE INDEX "qr_requests_expires_at_idx" ON "qr_requests"("expires_at");
