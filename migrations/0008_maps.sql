-- Интеллект-карты: отдельное «приложение в приложении». Дерево веток хранится одним JSON, в корзину карты не попадают
CREATE TABLE mind_maps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',            -- текст центральной ветки, для списка
  data        TEXT NOT NULL,                       -- JSON: {"nodeData": {...}}
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_mind_maps_user ON mind_maps (user_id, updated_at DESC);
