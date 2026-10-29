ALTER TABLE "users" ADD COLUMN "locale" VARCHAR(8) NOT NULL DEFAULT 'zh-CN';
ALTER TABLE "users" ADD CONSTRAINT "users_locale_check" CHECK ("locale" IN ('zh-CN', 'en'));
