-- Живой список покупок: один на человека, пункты с отметкой «куплено»
CREATE TABLE shopping_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  done        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  done_at     TEXT
);
CREATE INDEX idx_shopping_user ON shopping_items(user_id, done);
