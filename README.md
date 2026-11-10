# Блокнот — Telegram-бот для заметок и напоминаний

Один Cloudflare Worker: Telegram-бот (webhook), веб-страница, таймер напоминаний. Доступ по приглашению.
Статус: **этап 2 из 6** (приглашения, Mini App, управление людьми, текстовые заметки с DeepSeek).

## Как это устроено
Приложение — Telegram Mini App: открывается внутри Telegram, Telegram сам сообщает, кто его открыл (подписанные данные `initData`), Worker проверяет подпись по токену бота. Паролей, cookie и ссылок входа нет.

- Приглашение: админ пишет боту `/invite` (или `/invite Олег` с подписью) и получает ссылку `t.me/<бот>?startapp=КОД`. Человек открывает её в Telegram, вводит имя, и ссылка гасится. Дальше он заходит кнопкой «Блокнот» в чате с ботом.
- Админ (ID из секрета `ADMIN_TELEGRAM_ID`) знакомится с приложением без приглашения.
- В приложении: тема (авто: следует за темой Telegram и меняется сразу / светлая / тёмная), часовой пояс (определяется браузером), кнопка «Подключить бота» (разрешение боту писать).
- Панель управления (только админ): в приложении удерживайте значок ⚙️ в шапке (сверху справа) 2 секунды (обычное нажатие открывает настройки). Там список людей (заблокировать, вернуть доступ, удалить) и приглашения (создать, отправить, отозвать).
- Команды админа в боте: `/invite`, `/revoke`, `/users`, `/block`, `/unblock`, `/remove`.

## Развёртывание с нуля
1. `npm install`
2. В @BotFather: `/newbot` (имя «Блокнот»), запомнить токен и username.
3. `npx wrangler d1 create notes_db` → `database_id` вписать в `wrangler.toml`; туда же `BOT_USERNAME` (без @).
4. `npm run db:migrate`
5. Секреты (`npx wrangler secret put ИМЯ`): `TG_BOT_TOKEN`, `TG_WEBHOOK_SECRET` (случайная строка), `CRON_SECRET` (случайная строка), `ADMIN_TELEGRAM_ID` (ID из @userinfobot). `DEEPSEEK_API_KEY` (нужен с этапа 2; модель `deepseek-flash`), `GROQ_API_KEY` понадобится на этапе 3.
6. `npm run deploy` (домен notes.fixtorllc.com привязывается через `routes`).
7. Webhook, один раз:
   `curl "https://api.telegram.org/bot<ТОКЕН>/setWebhook" -d url=https://notes.fixtorllc.com/tg/webhook -d secret_token=<TG_WEBHOOK_SECRET>`
8. В @BotFather: **Bot Settings → Configure Mini App → Enable Mini App**, адрес `https://notes.fixtorllc.com`. Это включает прямые ссылки `t.me/<бот>?startapp=...`.
9. Кнопка «Блокнот» в чате (один раз):
   `curl "https://api.telegram.org/bot<ТОКЕН>/setChatMenuButton" -H 'content-type: application/json' -d '{"menu_button":{"type":"web_app","text":"Блокнот","web_app":{"url":"https://notes.fixtorllc.com"}}}'`
10. Откройте `t.me/<бот>?startapp` у себя: приложение предложит познакомиться.

## Локальная проверка
Секреты в `.dev.vars` (в git не попадает), `npm run db:migrate:local`, `npm run dev`, тесты: `npm test`. Вне Telegram приложение покажет просьбу открыть его через Telegram.
