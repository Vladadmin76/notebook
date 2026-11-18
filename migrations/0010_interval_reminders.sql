-- Напоминания «каждые N минут в окне дня» (например, пить воду каждые 2 часа с 8 до 20) и настойчивый режим:
-- пока человек не нажал «Готово», сообщение повторяется каждую минуту (новое заменяет прежнее), но не дольше, чем до следующего срока.
ALTER TABLE reminders ADD COLUMN int_minutes INTEGER;   -- шаг в минутах; NULL = обычное напоминание
ALTER TABLE reminders ADD COLUMN win_from TEXT;         -- начало окна дня, «08:00»
ALTER TABLE reminders ADD COLUMN win_to TEXT;           -- конец окна дня, «20:00» (последний срок не позже этого времени)
ALTER TABLE reminders ADD COLUMN int_days TEXT;         -- дни недели через запятую, «1,2,3,4,5,6»
ALTER TABLE reminders ADD COLUMN nag INTEGER NOT NULL DEFAULT 0;         -- настойчивый режим включён
ALTER TABLE reminders ADD COLUMN nag_active INTEGER NOT NULL DEFAULT 0;  -- сейчас идёт повтор каждую минуту
ALTER TABLE reminders ADD COLUMN nag_next TEXT;         -- когда отправить следующее повторение
ALTER TABLE reminders ADD COLUMN nag_until TEXT;        -- до какого времени повторять
ALTER TABLE reminders ADD COLUMN nag_msg INTEGER;       -- номер последнего сообщения в Telegram (его удаляем при замене)
CREATE INDEX idx_reminders_nag ON reminders(nag_active, nag_next);
