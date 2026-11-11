-- Корзина: удалённое не стирается сразу, а помечается (deleted_at) и хранится TRASH_DAYS дней
ALTER TABLE notes ADD COLUMN deleted_at TEXT;
ALTER TABLE notes ADD COLUMN deleted_with_folder INTEGER;     -- номер папки, если заметка ушла в корзину вместе с папкой
CREATE INDEX idx_notes_deleted ON notes(user_id, deleted_at);

ALTER TABLE folders ADD COLUMN deleted_at TEXT;
ALTER TABLE folders ADD COLUMN orig_name TEXT;                -- настоящее название удалённой папки (в name на время корзины лежит служебное, чтобы освободить имя)

ALTER TABLE shopping_lists ADD COLUMN deleted_at TEXT;
-- Уникальность названия списка теперь только среди не удалённых
DROP INDEX idx_shopping_lists_name;
CREATE UNIQUE INDEX idx_shopping_lists_name ON shopping_lists(user_id, name COLLATE NOCASE) WHERE deleted_at IS NULL;

ALTER TABLE shopping_items ADD COLUMN deleted_at TEXT;
ALTER TABLE shopping_items ADD COLUMN deleted_with_list INTEGER;
