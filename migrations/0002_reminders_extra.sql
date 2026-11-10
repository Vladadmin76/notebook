-- Напоминания: текст, часовой пояс и параметры повторов (рассчитываются в местном времени человека)
ALTER TABLE reminders ADD COLUMN text TEXT;          -- короткий текст напоминания (если нет, берётся текст заметки)
ALTER TABLE reminders ADD COLUMN tz TEXT;            -- пояс, в котором создано напоминание
ALTER TABLE reminders ADD COLUMN local_time TEXT;    -- «09:00» для повторяющихся
ALTER TABLE reminders ADD COLUMN anchor_date TEXT;   -- дата первой недели повтора, нужна для «раз в N недель»
