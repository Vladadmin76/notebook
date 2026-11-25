# Вход по приглашению и подключение бота (как это сделано в «Блокноте»)

Документ для другого Claude в другой сессии. Задача: повторить в другом проекте (например, fb2-bot) в точности такую же систему входа. Все факты ниже взяты из рабочего кода репозитория `Vladadmin76/notebook` (ветка `claude/adoring-turing-gquo7t`); ссылки на файлы указаны. Язык общения с владельцем: русский, он работает только с iPhone, отвечать коротко, объяснять по одному шагу.

---

## 1. Общая картина одним абзацем

Бот закрытый. Никто не может им пользоваться без одноразового приглашения. Владелец (админ, его Telegram ID лежит в секрете) создаёт приглашение: система генерирует случайный код и выдаёт ссылку `https://t.me/<БОТ>?startapp=<КОД>`. Человек открывает ссылку в Telegram: открывается **Mini App** (веб-страница, которую Telegram показывает внутри себя). Telegram передаёт странице подписанные данные о человеке (`initData`) и код из ссылки (`start_param`). Страница видит, что человека ещё нет в базе, показывает «Как тебя зовут?». Человек вводит имя и нажимает кнопку: одним нажатием (1) создаётся пользователь (приглашение гасится), (2) Telegram показывает окно «Разрешить боту писать вам?», (3) если человек разрешил, бот присылает приветствие, и подключение отмечено. Никаких кодов вручную вводить не нужно, ничего не переносить из одного места в другое.

Службы, которые участвуют: **Telegram** (Mini App, Bot API), **Cloudflare Worker** (одно приложение: и API, и бот, и статические файлы), **Cloudflare D1** (база SQLite), библиотека **grammY** (бот). Больше ничего: без OAuth, без паролей, без SMS, без внешней базы пользователей.

---

## 2. Из каких частей состоит

| Часть | Где | Что делает |
|---|---|---|
| Mini App (страница) | `public/index.html`, `public/app.js`, `public/style.css` | Показывается внутри Telegram. Читает `Telegram.WebApp.initData` и `start_param`, шлёт их на сервер заголовком `Authorization: tma <initData>`. |
| Проверка подписи | `src/auth.js` (`validateInitData`) | Проверяет, что данные действительно от Telegram и не старше 24 часов. |
| API входа | `src/index.js` (`handleApi`) | `/api/me`, `/api/join`, `/api/connect-bot`, `/api/admin/invite` и остальные. |
| База | `migrations/0001_init.sql` (+ далее), `src/db.js` | Таблицы `users`, `invites`, `audit`. |
| Бот (webhook) | `src/bot.js`, маршрут `/tg/webhook` в `src/index.js` | Принимает сообщения. Пускает только людей из `users`. Админские команды `/invite`, `/revoke`, `/users`, `/block`, `/unblock`, `/remove`. |
| Админ-панель | `public/app.js` (экран «Люди») | Приглашения и управление людьми без команд. |

Один Worker обслуживает всё. Файл `wrangler.toml`: `[assets]` с биндингом `ASSETS` и `run_worker_first = true` (сначала код Worker, потом статика), D1-биндинг `DB`, переменная `BOT_USERNAME` (имя бота без `@`), `keep_vars = true` (чтобы сборки из GitHub не стирали секреты, заведённые в панели).

---

## 3. Секреты и настройки (что нужно завести в новом проекте)

В Cloudflare: Worker → Settings → **Runtime** (не Build!) → Variables and secrets → тип Secret.

| Имя | Что это |
|---|---|
| `TG_BOT_TOKEN` | токен бота от @BotFather. Им же проверяется подпись `initData`. |
| `TG_WEBHOOK_SECRET` | случайная строка, **только** `A-Z a-z 0-9 _ -` (другие символы Telegram отвергает, и `setWebhook` отвечает 404). |
| `ADMIN_TELEGRAM_ID` | Telegram ID владельца (цифры). Именно он может зарегистрироваться без приглашения и создавать приглашения. |
| `CRON_SECRET` | только для таймера напоминаний, к входу не относится. |

`BOT_USERNAME` (имя бота без `@`, например `FixTorBlocknot_bot`) лежит в `wrangler.toml` как обычная переменная: она нужна для сборки ссылки приглашения.

В @BotFather:
1. `/newbot`: имя и username (кончается на `bot`).
2. `/mybots` → бот → Bot Settings → **Configure Mini App** → Enable Mini App → адрес приложения `https://<домен>`. Это включает прямые ссылки вида `https://t.me/<бот>?startapp=<КОД>` (так называемое Main Mini App). Без этого ссылки приглашений не откроют приложение.
3. Кнопка «Блокнот» внизу чата (меню): однократный запрос
   `https://api.telegram.org/bot<ТОКЕН>/setChatMenuButton?menu_button={"type":"web_app","text":"Блокнот","web_app":{"url":"https://<домен>"}}`
4. Webhook: `https://api.telegram.org/bot<ТОКЕН>/setWebhook?url=https://<домен>/tg/webhook&secret_token=<TG_WEBHOOK_SECRET>`. В ответе `"ok":true`.

---

## 4. База данных (то, что относится ко входу)

```sql
CREATE TABLE users (
  id          INTEGER PRIMARY KEY,           -- Telegram ID
  name        TEXT,                          -- как человек назван в Telegram
  label       TEXT NOT NULL,                 -- имя, которое человек ввёл при знакомстве
  tz          TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  theme       TEXT NOT NULL DEFAULT 'auto',
  can_write   INTEGER NOT NULL DEFAULT 0,    -- 1, когда бот смог написать человеку
  is_admin    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_users_label ON users(label COLLATE NOCASE);   -- имена уникальны без учёта регистра (только ASCII; кириллицу сравниваем в коде)

CREATE TABLE invites (
  code         TEXT PRIMARY KEY,             -- то, что в ссылке после startapp=
  note         TEXT,                         -- «для Олега», подпись админа
  created_by   INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT,                         -- отозвано
  used_by      INTEGER,                      -- Telegram ID того, кто открыл и представился
  used_at      TEXT
);
CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, actor INTEGER, action TEXT, target TEXT);  -- журнал: кто что сделал
```

Состояние приглашения (`db.inviteState`): нет записи → `missing`; есть `revoked_at` → `revoked`; есть `used_by` → `used`; иначе `open`.

Код приглашения: `randomToken(18)` из `src/util.js`: 18 случайных байт (`crypto.getRandomValues`), в base64url без `=`. Это 24 символа. Угадать нельзя.

---

## 5. Как человек входит: по шагам

### 5.1. Админ создаёт приглашение
Два пути, оба кладут запись в `invites` и возвращают ссылку:
- **Команда в боте**: `/invite Олег` (`src/bot.js`). Код `db.createInvite(D, note, adminId)`, ответ ботом со ссылкой `https://t.me/${BOT_USERNAME}?startapp=${code}`.
- **Панель в приложении**: `POST /api/admin/invite` с `{note}` (`src/index.js`), ответ `{code, note, link}`.

Приглашение одноразовое и на одного человека: «для Олега» нужна только как подпись. Отозвать можно (`/revoke Олег` или `POST /api/admin/revoke`): ставится `revoked_at`.

### 5.2. Человек открывает ссылку
`https://t.me/<бот>?startapp=<код>` открывает Mini App внутри Telegram. Telegram даёт странице:
- `Telegram.WebApp.initData`: строка вида `query_id=...&user=%7B%22id%22%3A...%7D&auth_date=...&hash=...`;
- `Telegram.WebApp.initDataUnsafe.start_param`: наш код приглашения;
- `initDataUnsafe.user.allows_write_to_pm`: `true`, если человек уже разрешил боту писать ему.

### 5.3. Страница запускается (`public/app.js`, блок «запуск», самый конец файла)
1. `tg.ready(); tg.expand();` (по возможности полный экран `tg.requestFullscreen()` на телефоне, Bot API 8.0+).
2. Если `initData` пустой (открыли не из Telegram): сообщение «Откройте приложение через Telegram».
3. `GET /api/me?code=<start_param>` с заголовком `Authorization: tma <initData>`.
4. Ответы: `403 blocked` → «Доступ закрыт»; `state: 'user'` → главный экран; `state: 'new'` + `invite: 'open' | 'admin'` → экран знакомства `screenJoin`; `invite: 'missing' | 'used' | 'revoked'` → сообщение «приглашение недействительно / использовано / отозвано».

### 5.4. Сервер проверяет личность (`src/index.js`, начало `handleApi`)
```js
const auth = request.headers.get('Authorization') ?? '';
const tgUser = auth.startsWith('tma ')
  ? await validateInitData(auth.slice(4), env.TG_BOT_TOKEN)
  : null;
if (!tgUser) return json({ error: 'unauthorized' }, 401);
const isAdminId = tgUser.id === Number(env.ADMIN_TELEGRAM_ID);
const user = await db.getUser(D, tgUser.id);
if (user?.status === 'blocked') return json({ error: 'blocked' }, 403);
```
**Единственная аутентификация: подпись Telegram.** Никаких токенов сессий, cookie, паролей. Каждый запрос приложения подписан заново (ту же `initData` страница шлёт каждый раз).

`src/auth.js` целиком (алгоритм из документации Telegram, без внешних библиотек, Web Crypto):
```js
export async function validateInitData(initData, botToken, maxAgeSec = 24 * 3600, nowSec = Math.floor(Date.now() / 1000)) {
  if (!initData || typeof initData !== 'string' || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = await hmac(enc.encode('WebAppData'), botToken);   // ключ = HMAC_SHA256("WebAppData", токен)
  const calc = toHex(await hmac(secret, dataCheckString));          // подпись = HMAC_SHA256(ключ, строка проверки)
  if (!safeEqual(calc, hash)) return null;                          // сравнение за постоянное время
  const authDate = Number(params.get('auth_date'));
  if (!authDate || nowSec - authDate > maxAgeSec) return null;     // старше 24 часов не принимаем
  const user = JSON.parse(params.get('user') ?? 'null');
  return user && Number.isSafeInteger(user.id) ? user : null;       // возвращает объект user целиком, в нём id, first_name, allows_write_to_pm и т.д.
}
```
(`hmac` = `crypto.subtle.importKey('raw', key, {name:'HMAC', hash:'SHA-256'}...)` + `sign`; `toHex`, `safeEqual` см. файл.) Из этого следует важное: **Telegram ID человека берётся только из подписанных данных**, подделать его нельзя.

### 5.5. Экран знакомства и регистрация (`screenJoin`, `/api/join`)
Страница показывает «Давай познакомимся / Как тебя зовут?», поле имени, подсказку про часовой пояс (из `Intl.DateTimeFormat().resolvedOptions().timeZone`) и кнопку «Познакомиться». По нажатию (`public/app.js`):
```js
const allowed = askWriteAccess();                       // (А) просим Telegram показать окно разрешения
const r = await api('/api/join', { name, tz: browserTz, code: startParam });   // (Б) регистрируем
if (r.ok) {
  me = r.data.user;
  allowed.then(async (ok) => { if (ok && !me.can_write) { const c = await api('/api/connect-bot', {}); if (c.ok && c.data.ok) me = c.data.user; } });
  return screenMain();
}
```
`askWriteAccess()` вызывает `tg.requestWriteAccess(cb)` (Bot API 6.9+). Особенности (**важно, не придумывать иначе**):
- Окно «Разрешить боту писать вам?» **рисует сам Telegram**, скрыть его или нажать за человека **нельзя**. Это запрет платформы.
- Если `initDataUnsafe.user.allows_write_to_pm === true`, окно не вызываем: Telegram уже знает о разрешении, сервер подключит бота сам.
- Если `requestWriteAccess` нет (старый клиент) или ответа нет 60 секунд (известная ошибка: повторный вызов в одной сессии иногда не возвращает callback), считаем «нет»: человек уже вошёл, кнопка «Подключить бота» остаётся в настройках.
- Отказ человека ничего не ломает.

Сервер (`/api/join`, `src/index.js`):
1. Если пользователь уже есть, вернуть его.
2. Проверить имя: `NAME_RE = /^[\p{L}\p{N} .'-]{1,40}$/u`, часовой пояс `isValidTz`.
3. `db.registerUser(D, { id: tgUser.id, tgName: tgUser.first_name, label, tz, code, isAdmin: isAdminId })`.
4. Ошибки: `label_taken` (имя занято), `invite_unavailable` (приглашение недействительно/использовано/отозвано).
5. Админу уходит сообщение «Новый человек в Блокноте: …» (`ctx.waitUntil`, ошибки глотаем).
6. Если Telegram передал `tgUser.allows_write_to_pm`, сразу `connectBot()` (ниже) и вернуть пользователя с `can_write = 1`.

**Ключевое место безопасности, регистрация одной транзакцией** (`db.registerUser`, D1 `batch` = транзакция): приглашение гасится только вместе с созданием пользователя, и двое по одному коду не пройдут:
```sql
-- 1) создать пользователя ТОЛЬКО если приглашение существует, не использовано и не отозвано
INSERT INTO users (id, name, label, tz, is_admin, status, created_at)
SELECT ?, ?, ?, ?, 0, 'active', ?
WHERE EXISTS (SELECT 1 FROM invites WHERE code = ? AND used_by IS NULL AND revoked_at IS NULL);
-- 2) погасить приглашение
UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL AND revoked_at IS NULL;
-- 3) стартовые папки пользователя (только если пользователь создан)
INSERT INTO folders (...) SELECT ... WHERE EXISTS (SELECT 1 FROM users WHERE id = ?);
```
Админ (ID из секрета) регистрируется без приглашения: отдельная ветка `isAdmin`. Если `INSERT` нарушил уникальность (`UNIQUE`), возвращаем `label_taken`. Если после `batch` пользователя нет, возвращаем `invite_unavailable`.

### 5.6. Подключение бота (`connectBot`, `/api/connect-bot`)
```js
async function connectBot(env, D, userId) {
  try {
    await getBot(env).bot.api.sendMessage(userId, 'Бот подключён. Пишите или наговаривайте сюда заметки…');
  } catch { return false; }          // Telegram не позволил написать: человек не разрешил
  await db.markCanWrite(D, userId);  // UPDATE users SET can_write = 1 WHERE id = ?
  return true;
}
```
Идея: **приветственное сообщение и есть проверка** (если разрешения нет, `sendMessage` падает с 403, и мы честно не отмечаем подключение). `POST /api/connect-bot` вызывает его для текущего пользователя и возвращает `{ok: true, user}` или `{ok: false}`. Та же кнопка «Подключить бота» в «Настройки → Бот» на случай отказа при входе.

Кроме этого в настройках остаётся запасная кнопка («Подключить бота», вызывает `tg.requestWriteAccess` и затем `/api/connect-bot`); если и она не сработала, показываем: «Откройте чат с ботом, нажмите Start и повторите».

---

## 6. Как защищён бот (webhook, `src/bot.js`)

- Webhook `/tg/webhook` принимает запросы только с заголовком `X-Telegram-Bot-Api-Secret-Token` = `TG_WEBHOOK_SECRET` (иначе 401). Отвечает Telegram сразу `200`, остальное делает в фоне `ctx.waitUntil(bot.handleUpdate(update))` (иначе Telegram повторит доставку).
- Единый фильтр допуска в самом начале (`bot.use`): работает только в личных чатах; нет в `users` → ответ «Бот работает по приглашению. Попросите у владельца ссылку-приглашение…» (админу, если он ещё не регистрировался: «Сначала откройте приложение и познакомьтесь с ботом»); `blocked` → «Доступ закрыт.»; иначе `ctx.user = user; next()`.
- Регистрироваться можно **только в приложении**, не в боте: боту нельзя «прислать код», чтобы войти.
- Admin-команды проверяют `ctx.user.is_admin` и молча игнорируют остальных.
- Бот создаётся с `botInfo` из токена (`createBot(env)`), без вызова `getMe`, чтобы не зависеть от Telegram при старте (раньше бесконечные повторы `getMe` вешали бота).

## 7. Управление людьми

Панель админа (в приложении: удержать значок ⚙️ 2 секунды) и команды: список людей и открытых приглашений (`/users`, `GET /api/admin/overview`), заблокировать/разблокировать (`status`), удалить с данными (`ON DELETE CASCADE`), отозвать приглашение. Админа нельзя заблокировать или удалить. Каждое действие пишется в `audit`.

---

## 8. Защита (чего не забыть при переносе)

- Подпись `initData` проверяется на **каждом** запросе (`Authorization: tma …`), срок 24 часа, длина ≤ 4096.
- Изоляция данных: каждый запрос работает только с данными `user.id`, взятого из подписи. Любое обращение к чужим записям даёт 404.
- Content-Security-Policy на страницах: `default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org https://t.me; base-uri 'none'; form-action 'none'; object-src 'none'`. Скрипт `https://telegram.org/js/telegram-web-app.js` подключён в `index.html`. Плюс `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- Лимит тела запроса 100 КБ (отклоняется до обработки).
- Приглашение: 18 случайных байт, одноразовое, отзываемое, погашение транзакцией.
- Секреты только в Runtime-секретах Cloudflare, в репозиторий не попадают (`.dev.vars` в `.gitignore`).
- Токен бота не светить в чате: он же ключ подписи.

---

## 9. Как проверить (тесты в репозитории)

- `test/auth.test.js`: юнит-тесты подписи (верная, неверная, чужой бот, просроченная).
- `npm run check:isolation` (`scripts/isolation-check.mjs`): сквозная проверка на локальном `npm run dev`: вход без подписи 401, подпись чужого бота, просроченная, подмена ID; регистрация без приглашения запрещена; приглашение работает один раз; изоляция данных между людьми; права админа; блокировка.
- `npm run check:maps` (включает `scripts/browser/join.cjs`): в браузере с подменой Telegram три сценария входа: человек разрешил (окно показано 1 раз, бот подключён), отказал (вошёл, бот не подключён), Telegram уже знает (`allows_write_to_pm`, окна нет, бот подключён сервером).
- Локально нужен `.dev.vars` (в нём `TG_BOT_TOKEN`, `TG_WEBHOOK_SECRET`, `CRON_SECRET`, `ADMIN_TELEGRAM_ID`, для проверок `TG_API_ROOT=http://127.0.0.1:8099`).

---

## 10. Чек-лист переноса в другой проект

1. Создать (или взять) бота в @BotFather, включить Main Mini App с адресом приложения. **Для каждого проекта свой бот и свои секреты**: не использовать токен Блокнота.
2. Завести Worker, D1, секреты `TG_BOT_TOKEN`, `TG_WEBHOOK_SECRET`, `ADMIN_TELEGRAM_ID`; в `wrangler.toml` `BOT_USERNAME`, `keep_vars = true`, `[assets]` с `run_worker_first = true`.
3. Миграции: таблицы `users`, `invites`, `audit` (как в разделе 4).
4. Скопировать `src/auth.js` как есть. Подключить проверку подписи в начало API (раздел 5.4).
5. Реализовать `/api/me`, `/api/join` (регистрация одной транзакцией, раздел 5.5), `/api/connect-bot` + функцию `connectBot`, `/api/admin/invite|revoke|overview|block|unblock|remove`.
6. Страница: блок «запуск» (раздел 5.3), экран знакомства и `askWriteAccess` (раздел 5.5), `Authorization: tma <initData>` в каждом запросе.
7. Бот: webhook с секретом, фильтр допуска, команды `/invite`, `/revoke`, `/users`, `/block`, `/unblock`, `/remove`.
8. Прогнать сценарии из раздела 9 (особенно «разрешил / отказал / уже знает»).
9. Старую схему «временный код, перенос кода» полностью убрать: больше нет ни ввода кода, ни ссылки с кодом в чате бота. Единственный вход: ссылка `t.me/<бот>?startapp=<код>`.

## 11. Подводные камни, на которые мы уже наступали

- `setWebhook` отвечает 404, если в секрете есть недопустимые символы или в токене лишний пробел.
- Секреты, добавленные в панели, стирались сборками из GitHub, пока не включили `keep_vars = true` (и вводили секреты в разделе **Runtime**, а не Build).
- SQLite `COLLATE NOCASE` работает только для латиницы: имена «Олег» и «ОЛЕГ» различаются, сравнивать нужно в коде.
- Окно разрешения Telegram скрыть нельзя; человек, который его отклонил, остаётся без уведомлений, пока не подключит бота в настройках или не нажмёт Start в чате.
- Если приглашение открыто не из Telegram (в обычном браузере), `initData` пуст: показываем подсказку, а не пытаемся входить.
- После деплоя Telegram может держать старую версию страницы: закрыть приложение полностью и открыть заново.
