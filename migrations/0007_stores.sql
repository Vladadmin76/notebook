-- Магазины человека: избранные из готового перечня, свои магазины и выученные написания (например «Костко» для Costco)
CREATE TABLE user_stores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                       -- каноническое название (Costco)
  custom      INTEGER NOT NULL DEFAULT 0,          -- 1: добавлен самим человеком, 0: из готового перечня
  favorite    INTEGER NOT NULL DEFAULT 0,
  aliases     TEXT NOT NULL DEFAULT '[]',          -- JSON: другие написания и произношения
  created_at  TEXT NOT NULL,
  UNIQUE (user_id, name)
);
