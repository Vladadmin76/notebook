-- Пауза и выключение повторяющихся напоминаний (разовых это не касается)
ALTER TABLE reminders ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;   -- 1: выключено, пока человек не включит
ALTER TABLE reminders ADD COLUMN paused_until TEXT;                  -- пауза «на сегодня»: до этого времени (полночь по местному времени) сроки пропускаются
