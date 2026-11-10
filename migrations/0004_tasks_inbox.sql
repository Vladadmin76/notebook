-- Задачи: отметка «выполнено»; папки особого вида; ежедневное напоминание о «Входящих»; ожидание комментария к ссылке
ALTER TABLE notes ADD COLUMN done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN done_at TEXT;

ALTER TABLE folders ADD COLUMN kind TEXT;        -- 'tasks' | 'misc' | 'inbox' | NULL (обычная папка)
UPDATE folders SET kind = 'tasks' WHERE name = 'Задачи' COLLATE NOCASE;
UPDATE folders SET kind = 'misc'  WHERE name = 'Разное' COLLATE NOCASE;
UPDATE folders SET kind = 'inbox' WHERE name = 'Входящие' COLLATE NOCASE;

ALTER TABLE users ADD COLUMN inbox_digest_on TEXT;   -- дата (по местному времени), когда напоминание о «Входящих» уже отправлено

CREATE TABLE user_state (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                  -- 'comment': следующее сообщение станет комментарием к заметке note_id
  note_id     INTEGER,
  expires_at  TEXT NOT NULL
);
