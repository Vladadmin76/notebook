-- Схема «Блокнота». Все времена: ISO-строки в UTC.

CREATE TABLE users (
  id          INTEGER PRIMARY KEY,           -- Telegram ID
  name        TEXT,                          -- как человек назван в Telegram
  label       TEXT NOT NULL,                 -- имя, которое человек ввёл при знакомстве
  tz          TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  theme       TEXT NOT NULL DEFAULT 'auto' CHECK (theme IN ('auto','light','dark')),
  can_write   INTEGER NOT NULL DEFAULT 0,    -- 1, когда бот смог написать человеку
  is_admin    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_users_label ON users(label COLLATE NOCASE);

CREATE TABLE invites (
  code         TEXT PRIMARY KEY,             -- startapp=КОД в ссылке t.me
  note         TEXT,                         -- «для Олега», необязательная подпись админа
  created_by   INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT,
  used_by      INTEGER,                      -- Telegram ID того, кто открыл и представился
  used_at      TEXT
);

CREATE TABLE folders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id   INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  text        TEXT NOT NULL,
  raw_text    TEXT,
  source      TEXT NOT NULL DEFAULT 'text' CHECK (source IN ('text','voice')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_notes_user_folder  ON notes(user_id, folder_id);
CREATE INDEX idx_notes_user_created ON notes(user_id, created_at);

CREATE TABLE reminders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id     INTEGER REFERENCES notes(id) ON DELETE CASCADE,
  remind_at   TEXT NOT NULL,
  rrule       TEXT,                          -- правило повторения (RFC 5545), NULL = разовое
  until_at    TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','cancelled')),
  sent_at     TEXT
);
CREATE INDEX idx_reminders_due ON reminders(status, remind_at);

CREATE TABLE audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  actor       INTEGER NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT
);
