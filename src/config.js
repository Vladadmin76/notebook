// Все настраиваемые значения в одном месте.
export const LIMITS = {
  VOICE_MAX_SECONDS: 180,   // голосовое длиннее — отказ
  TEXT_MAX_CHARS: 2000,     // заметка длиннее — отказ
};

export const DEFAULT_TZ = 'America/Los_Angeles';
export const START_FOLDERS = ['Идеи', 'Задачи', 'Покупки', 'Разное'];
export const SESSION_DAYS = 30;
export const LOGIN_LINK_MINUTES = 10;

// Особые папки: определяются по названию при создании, дальше по полю kind (переживает переименование)
export const FOLDER_KINDS = { 'Задачи': 'tasks', 'Разное': 'misc', 'Входящие': 'inbox' };
export const INBOX_NAME = 'Входящие';
export const DIGEST_HOUR = 12; // во сколько (по местному времени человека) напоминать о неразобранных ссылках
