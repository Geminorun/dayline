BEGIN;

ALTER TABLE "users" ADD COLUMN "data_version" BIGINT NOT NULL DEFAULT 1,
ADD COLUMN "initialized_at" TIMESTAMPTZ(3);
ALTER TABLE "users" ADD CONSTRAINT "users_data_version_positive" CHECK (data_version > 0);
CREATE TABLE "categories" (
  "id" UUID PRIMARY KEY, "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL, "color" TEXT NOT NULL, "seed_key" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "categories_name_check" CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 12),
  CONSTRAINT "categories_color_check" CHECK (color ~ '^#[0-9A-F]{6}$'),
  CONSTRAINT "categories_version_check" CHECK (version > 0)
);
CREATE UNIQUE INDEX "categories_user_id_name_key" ON "categories"("user_id", "name");
CREATE UNIQUE INDEX "categories_id_user_id_key" ON "categories"("id", "user_id");
CREATE UNIQUE INDEX "categories_user_id_seed_key_key" ON "categories"("user_id", "seed_key");
CREATE TABLE "entries" (
  "id" UUID PRIMARY KEY, "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "category_id" UUID NOT NULL, "title" TEXT NOT NULL, "start_date" DATE NOT NULL, "end_date" DATE,
  "version" INTEGER NOT NULL DEFAULT 1, "focus_version" INTEGER NOT NULL DEFAULT 1,
  "deleted_at" TIMESTAMPTZ(3), "purge_after" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "entries_category_id_user_id_fkey" FOREIGN KEY (category_id, user_id) REFERENCES categories(id, user_id) ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "entries_title_check" CHECK (title = btrim(title) AND char_length(title) BETWEEN 1 AND 100),
  CONSTRAINT "entries_dates_check" CHECK (start_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' AND (end_date IS NULL OR (end_date >= start_date AND end_date <= DATE '9999-12-31'))),
  CONSTRAINT "entries_deletion_check" CHECK ((deleted_at IS NULL AND purge_after IS NULL) OR (deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after >= deleted_at)),
  CONSTRAINT "entries_versions_check" CHECK (version > 0 AND focus_version > 0)
);
CREATE INDEX "entries_user_id_start_date_id_idx" ON entries(user_id, start_date, id);
CREATE INDEX "entries_user_id_category_id_idx" ON entries(user_id, category_id);
CREATE INDEX "entries_user_id_deleted_at_idx" ON entries(user_id, deleted_at);
CREATE INDEX "entries_purge_after_idx" ON entries(purge_after) WHERE deleted_at IS NOT NULL;
CREATE TABLE "entry_focus_days" (
  "entry_id" UUID NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  "date" DATE NOT NULL, "focused" BOOLEAN NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entry_id, date),
  CONSTRAINT "entry_focus_days_date_check" CHECK (date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  CONSTRAINT "entry_focus_days_version_check" CHECK (version > 0)
);
-- Initialization belongs to the INSERT transaction, including Better Auth's adapter
-- transaction. No root-client hook can observe an uncommitted user or deadlock.
CREATE FUNCTION initialize_dayline_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO categories(id, user_id, name, color, seed_key)
  SELECT pg_catalog.gen_random_uuid(), NEW.id, seed.name, seed.color, seed.key
  FROM (VALUES ('game','游戏','#8B80D8'), ('reading','阅读','#6C9BCE'),
    ('work','工作','#D6A063'), ('sport','运动','#6CA58A'),
    ('life','生活','#B88EAA'), ('other','其他','#A0A4B3')) AS seed(key,name,color);
  UPDATE users SET initialized_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_initialize_dayline AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION initialize_dayline_user();
-- Upgrade existing accounts exactly once, without checking category counts.
INSERT INTO categories(id, user_id, name, color, seed_key)
SELECT pg_catalog.gen_random_uuid(), users.id, seed.name, seed.color, seed.key
FROM users CROSS JOIN (VALUES ('game','游戏','#8B80D8'), ('reading','阅读','#6C9BCE'),
  ('work','工作','#D6A063'), ('sport','运动','#6CA58A'),
  ('life','生活','#B88EAA'), ('other','其他','#A0A4B3')) AS seed(key,name,color)
WHERE users.initialized_at IS NULL;
UPDATE users SET initialized_at = CURRENT_TIMESTAMP WHERE initialized_at IS NULL;

COMMIT;
