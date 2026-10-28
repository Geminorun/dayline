ALTER TABLE categories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
-- Preserve the order users saw before this migration.
WITH ranked AS (
  SELECT id, (row_number() OVER (PARTITION BY user_id ORDER BY created_at, id) - 1)::integer AS position
  FROM categories
)
UPDATE categories SET sort_order = ranked.position FROM ranked WHERE categories.id = ranked.id;
ALTER TABLE categories ADD CONSTRAINT categories_sort_order_check CHECK (sort_order >= 0);
CREATE OR REPLACE FUNCTION initialize_dayline_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO categories(id, user_id, name, color, seed_key, sort_order)
  SELECT pg_catalog.gen_random_uuid(), NEW.id, seed.name, seed.color, seed.key, seed.position
  FROM (VALUES ('game','游戏','#8B80D8',0), ('reading','阅读','#6C9BCE',1),
    ('work','工作','#D6A063',2), ('sport','运动','#6CA58A',3),
    ('life','生活','#B88EAA',4), ('other','其他','#A0A4B3',5)) AS seed(key,name,color,position);
  UPDATE users SET initialized_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  RETURN NEW;
END;
$$;
