# Блокнот — Telegram-бот для заметок и напоминаний

Один Cloudflare Worker: Telegram-бот (webhook), веб-страница, таймер напоминаний. Доступ по приглашению.
Статус: **этап 1 из 6** (каркас: приглашения, допуск, управление людьми).

## Развёртывание с нуля
1. `npm install`
2. Создать бота в @BotFather (`/newbot`), записать токен и username.
3. `npx wrangler d1 create notes_db` → `database_id` вписать в `wrangler.toml`. Туда же `BOT_USERNAME` (без @).
4. `npm run db:migrate`
5. Секреты (`npx wrangler secret put ИМЯ`): `TG_BOT_TOKEN`, `TG_WEBHOOK_SECRET` (случайная строка), `CRON_SECRET` (случайная строка), `ADMIN_TELEGRAM_ID` (ваш ID из @userinfobot). `DEEPSEEK_API_KEY` и `GROQ_API_KEY` понадобятся на этапах 2–3.
6. `npm run deploy` (домен notes.fixtorllc.com привязывается через `routes`).
7. Один раз зарегистрировать webhook:
   `curl "https://api.telegram.org/bot<ТОКЕН>/setWebhook" -d url=https://notes.fixtorllc.com/tg/webhook -d secret_token=<TG_WEBHOOK_SECRET>`

## Как приглашать
Админ пишет боту `/invite Олег` → получает одноразовую ссылку. Человек открывает её в браузере, проверяет время и часовой пояс, жмёт «подключить бота» и нажимает Start. Приглашение гасится только в этот момент.

Команды админа: `/invite`, `/revoke`, `/users`, `/block`, `/unblock`, `/remove`.

## Локальная проверка
Скопируйте секреты в `.dev.vars` (в git не попадает), `npm run db:migrate:local`, `npm run dev`.
