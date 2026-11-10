// Проверка изоляции данных и защит на запущенном локально приложении (npm run dev).
// Запуск: npm run check:isolation   (нужен .dev.vars с TG_BOT_TOKEN, TG_WEBHOOK_SECRET, CRON_SECRET, ADMIN_TELEGRAM_ID, TG_API_ROOT=http://127.0.0.1:8099)
// Скрипт сам поднимает заглушку Telegram на порту из TG_API_ROOT. Никаких запросов во внешний мир.
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import http from 'node:http';

const env = Object.fromEntries(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').split('\n')
  .filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const BASE = process.argv[2] ?? 'http://localhost:8787';
const ADMIN = Number(env.ADMIN_TELEGRAM_ID);
const B = 900001, C = 900002;

// --- заглушка Telegram (если порт свободен) ---
const root = new URL(env.TG_API_ROOT ?? 'http://127.0.0.1:8099');
const mock = http.createServer((req, res) => {
  req.on('data', () => {}); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const m = req.url.split('/').pop();
    if (m === 'getMe') return res.end(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: 'B', username: 'test_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } }));
    res.end(JSON.stringify({ ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: 'private' } } }));
  });
});
await new Promise((r) => mock.once('error', r).listen(Number(root.port), root.hostname, r)).catch(() => {});

// --- подпись данных Telegram ---
function initData(id, name, authDate = Math.floor(Date.now() / 1000), token = env.TG_BOT_TOKEN) {
  const p = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify({ id, first_name: name }) });
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  p.set('hash', createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}
const call = async (as, path, body, opts = {}) => {
  const r = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(as ? { Authorization: 'tma ' + as } : {}), ...(opts.headers ?? {}) },
    body: body === undefined ? undefined : (opts.raw ?? JSON.stringify(body)),
  });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
};
const webhook = (text, from) => fetch(BASE + '/tg/webhook', { method: 'POST',
  headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': env.TG_WEBHOOK_SECRET },
  body: JSON.stringify({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: 1, date: 1, chat: { id: from, type: 'private' }, from: { id: from, is_bot: false, first_name: 'T' }, text } }) });

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); if (!ok) fails++; };

const A = initData(ADMIN, 'Admin'), Bd = initData(B, 'Bob'), Cd = initData(C, 'Carol');

// --- 1. вход: без подписи, чужая подпись, просроченная ---
check('без подписи: 401', (await call(null, '/api/me')).status === 401);
check('подпись чужого бота: 401', (await call(initData(B, 'x', undefined, '111:other'), '/api/me')).status === 401);
check('просроченная подпись (>24 ч): 401', (await call(initData(B, 'x', Math.floor(Date.now() / 1000) - 90000), '/api/me')).status === 401);
const tampered = Bd.replace(String(B), String(B + 1));
check('подмена Telegram ID внутри подписанных данных: 401', (await call(tampered, '/api/me')).status === 401);

// --- 2. webhook и таймер ---
check('webhook без секрета: 401', (await fetch(BASE + '/tg/webhook', { method: 'POST', body: '{}' })).status === 401);
check('webhook с неверным секретом: 401', (await fetch(BASE + '/tg/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'x' }, body: '{}' })).status === 401);
check('таймер без секрета: 403', (await fetch(BASE + '/cron/tick')).status === 403);
check('таймер с неверным секретом: 403', (await fetch(BASE + '/cron/tick', { headers: { 'X-Cron-Secret': 'x' } })).status === 403);

// --- 3. регистрация: админ без приглашения, чужой без приглашения, приглашение одноразовое ---
let me = await call(A, '/api/me');
if (me.data?.state !== 'user') await call(A, '/api/join', { name: 'Админ', tz: 'UTC' });
check('чужой без приглашения не может зарегистрироваться', (await call(Bd, '/api/join', { name: 'Bob', tz: 'UTC' })).status === 409);
const inv = await call(A, '/api/admin/invite', { note: 'проверка' });
const bj = await call(Bd, '/api/join', { name: `Боб${Date.now() % 10000}`, tz: 'Europe/Moscow', code: inv.data.code });
check('по приглашению человек регистрируется', bj.status === 200 && bj.data.state === 'user', JSON.stringify(bj.data));
const cj = await call(Cd, '/api/join', { name: 'Карол', tz: 'UTC', code: inv.data.code });
check('то же приглашение второй раз не работает', cj.status === 409, JSON.stringify(cj));

// --- 4. данные админа ---
await webhook('секретная заметка админа про проект Альфа', ADMIN);
await new Promise((r) => setTimeout(r, 2500));
const an = await call(A, '/api/notes');
const secret = an.data.notes.find((n) => n.text.includes('Альфа'));
check('админ видит свою заметку', !!secret, JSON.stringify(an.data).slice(0, 120));
const N = secret?.id, F = secret?.folder_id;
const when = new Date(Date.now() + 2 * 86400e3).toISOString().slice(0, 10) + 'T10:00';
await call(A, '/api/reminders/set', { note_id: N, local: when });
const shopA = await call(A, '/api/shopping/add', { name: 'Секретный товар' });
const itemId = shopA.data.items.find((i) => i.name === 'Секретный товар')?.id;
check('у админа есть заметка, напоминание и пункт покупок', !!(N && itemId));
check('админская ссылка .ics создаётся', (await call(A, `/api/ics-link?note_id=${N}`)).status === 200);

// --- 5. второй человек не видит и не меняет чужое ---
const nB = await call(Bd, '/api/notes');
check('второй человек не видит заметки админа в списке', nB.data.total === 0 && !JSON.stringify(nB.data).includes('Альфа'));
check('поиск по словам из чужой заметки ничего не находит', (await call(Bd, '/api/notes?q=' + encodeURIComponent('Альфа'))).data.total === 0);
check('чужая заметка по номеру: 404', (await call(Bd, `/api/note?id=${N}`)).status === 404);
check('правка чужой заметки: 404', (await call(Bd, '/api/notes/update', { id: N, text: 'взлом' })).status === 404);
check('отметка чужой заметки: 404', (await call(Bd, '/api/notes/toggle', { id: N })).status === 404);
check('удаление чужой заметки: 404', (await call(Bd, '/api/notes/delete', { id: N })).status === 404);
check('напоминание к чужой заметке: 404', (await call(Bd, '/api/reminders/set', { note_id: N, local: when })).status === 404);
check('ссылка .ics для чужой заметки: 404', (await call(Bd, `/api/ics-link?note_id=${N}`)).status === 404);
check('перенос своей заметки в чужую папку невозможен',
  (await call(Bd, '/api/notes/update', { id: N, folder_id: F })).status !== 200);
check('чужая папка: список заметок пуст', (await call(Bd, `/api/notes?folder=${F}`)).data.total === 0);
check('переименование чужой папки: 404', (await call(Bd, '/api/folders/rename', { id: F, name: 'Взлом' })).status === 404);
check('удаление чужой папки: 404', (await call(Bd, '/api/folders/delete', { id: F })).status === 404);
await call(Bd, '/api/shopping/toggle', { id: itemId });
await call(Bd, '/api/shopping/delete', { id: itemId });
const after = (await call(A, '/api/shopping')).data.items.find((i) => i.id === itemId);
check('чужой пункт покупок не изменился и не удалился', !!after && !after.done);
const L = (await call(A, '/api/shopping/lists/create', { name: 'Секретный магазин' })).data?.id;
check('у админа есть свой список покупок по магазину', !!L);
check('чужой список по номеру: 404', (await call(Bd, `/api/shopping?list=${L}`)).status === 404);
check('переименование чужого списка: 404', (await call(Bd, '/api/shopping/lists/rename', { id: L, name: 'Взлом' })).status === 404);
check('удаление чужого списка: 404', (await call(Bd, '/api/shopping/lists/delete', { id: L })).status === 404);
check('добавление пункта в чужой список: 404', (await call(Bd, '/api/shopping/add', { name: 'Подброс', list_id: L })).status === 404);
check('перенос чужого пункта: 404', (await call(Bd, '/api/shopping/move', { id: itemId, list_id: null })).status === 404);
check('списки второго человека не содержат чужих магазинов', !JSON.stringify((await call(Bd, '/api/shopping')).data).includes('Секретный'));
check('список админа остался на месте', (await call(A, '/api/shopping')).data.lists.some((l) => l.id === L));
check('список покупок второго человека не содержит чужих пунктов', !JSON.stringify((await call(Bd, '/api/shopping')).data).includes('Секретный'));
check('календарь второго человека пуст', Object.keys((await call(Bd, `/api/calendar?month=${when.slice(0, 7)}`)).data.days).length === 0);
const aAfter = await call(A, `/api/note?id=${N}`);
check('заметка админа осталась нетронутой', aAfter.data.note.text.includes('Альфа'));

// --- 6. права администратора ---
for (const p of ['/api/admin/overview']) check(`обычному человеку ${p}: 403`, (await call(Bd, p)).status === 403);
for (const p of ['/api/admin/invite', '/api/admin/block', '/api/admin/unblock', '/api/admin/remove', '/api/admin/revoke'])
  check(`обычному человеку ${p}: 403`, (await call(Bd, p, { id: ADMIN, note: 'x', code: 'x' })).status === 403);
check('админа нельзя заблокировать', (await call(A, '/api/admin/block', { id: ADMIN })).status === 400);

// --- 7. блокировка и возврат ---
await call(A, '/api/admin/block', { id: B });
check('заблокированный: 403', (await call(Bd, '/api/me')).status === 403);
await call(A, '/api/admin/unblock', { id: B });
check('после разблокировки доступ вернулся', (await call(Bd, '/api/me')).status === 200);

// --- 8. подписанная ссылка .ics ---
const link = (await call(A, `/api/ics-link?note_id=${N}`)).data.ics;
const lp = new URL(link);
const url = new URL(lp.pathname + lp.search, BASE); // ссылка ведёт на боевой адрес, проверяем тот же путь на локальном
check('подписанная ссылка .ics открывается', (await fetch(url)).status === 200);
const bad = new URL(url); bad.searchParams.set('u', String(B));
check('ссылка .ics с подменённым владельцем: 403', (await fetch(bad)).status === 403);
const bad2 = new URL(url); bad2.searchParams.set('s', 'a'.repeat(40));
check('ссылка .ics с чужой подписью: 403', (await fetch(bad2)).status === 403);
const old = new URL(url); old.searchParams.set('e', String(Math.floor(Date.now() / 1000) - 5));
check('просроченная ссылка .ics: 403', (await fetch(old)).status === 403);

// --- 9. защитные заголовки и размер запроса ---
const page = await fetch(BASE + '/');
check('заголовок Content-Security-Policy задан', (page.headers.get('content-security-policy') ?? '').includes("frame-ancestors"));
check('заголовок X-Content-Type-Options: nosniff', page.headers.get('x-content-type-options') === 'nosniff');
check('слишком большой запрос: 413', (await call(A, '/api/notes/update', {}, { raw: 'x'.repeat(200_000) })).status === 413);

// --- уборка: удаляем тестового человека ---
await call(A, '/api/admin/remove', { id: B });
await call(A, '/api/notes/delete', { id: N });
await call(A, '/api/shopping/delete', { id: itemId });
await call(A, '/api/shopping/lists/delete', { id: L });
console.log(fails ? `\nНЕ ПРОЙДЕНО проверок: ${fails}` : '\nВсе проверки пройдены');
mock.close();
process.exit(fails ? 1 : 0);
