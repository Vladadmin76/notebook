-- Списки покупок по магазинам. Пункты без списка (list_id пусто) лежат в «Без магазина»; все старые пункты остаются там.
CREATE TABLE shopping_lists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_shopping_lists_name ON shopping_lists(user_id, name COLLATE NOCASE);

ALTER TABLE shopping_items ADD COLUMN list_id INTEGER;
CREATE INDEX idx_shopping_items_list ON shopping_items(user_id, list_id, done);
