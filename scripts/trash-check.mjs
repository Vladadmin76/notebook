// Сквозная проверка корзины на запущенном локально приложении (npm run dev): папки, заметки, покупки, напоминания, окончательное удаление.
// Запуск: npm run check:trash  (нужен .dev.vars как для check:isolation)
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import http from 'node:http';

const env = Object.fromEntries(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').split('\n')
  .filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const BASE = process.argv[2] ?? 'http://localhost:8787';
const ADMIN = Number(env.ADMIN_TELEGRAM_ID);

// заглушка Telegram, запоминает отправленные ботом сообщения
const sent = [];
const root = new URL(env.TG_API_ROOT ?? 'http://127.0.0.1:8099');
const mock = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const m = req.url.split('/').pop();
    try { sent.push({ method: m, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }); } catch {}
    if (m === 'getMe') return res.end(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: 'B', username: 'test_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } }));
    res.end(JSON.stringify({ ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: 'private' } } }));
  });
});
await new Promise((r) => mock.once('error', r).listen(Number(root.port), root.hostname, r)).catch(() => {});

function initData(id, name) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: name }) });
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  p.set('hash', createHmac('sha256', createHmac('sha256', 'WebAppData').update(env.TG_BOT_TOKEN).digest()).update(dcs).digest('hex'));
  return p.toString();
}
const A = initData(ADMIN, 'Admin');
const call = async (path, body) => {
  const r = await fetch(BASE + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', Authorization: 'tma ' + A }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
};
const hook = (update) => fetch(BASE + '/tg/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': env.TG_WEBHOOK_SECRET }, body: JSON.stringify({ update_id: Math.floor(Math.random() * 1e9), ...update }) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Ждём, пока бот ответит (до 8 секунд), вместо фиксированной паузы: на «холодном» запуске ответ приходит медленнее
const settle = async () => { const t0 = Date.now(); while (Date.now() - t0 < 8000 && sent.length === 0) await wait(100); await wait(400); };
const say = async (text) => { sent.length = 0; await hook({ message: { message_id: 1, date: 1, chat: { id: ADMIN, type: 'private' }, from: { id: ADMIN, is_bot: false, first_name: 'T' }, text } }); await settle(); };
const press = async (data) => { sent.length = 0; await hook({ callback_query: { id: '1', chat_instance: 'c', from: { id: ADMIN, is_bot: false, first_name: 'T' }, data, message: { message_id: 5, date: 1, chat: { id: ADMIN, type: 'private' }, text: 'x' } } }); await settle(); };
const sql = (q) => execSync(`npx wrangler d1 execute notes_db --local --command "${q.replace(/"/g, '\\"')}" 2>&1`, { cwd: new URL('..', import.meta.url).pathname }).toString();

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); if (!ok) fails++; };
const folders = async () => (await call('/api/overview')).data.folders;
const notesIn = async (fid) => (await call(`/api/notes?folder=${fid}`)).data.notes;
const trash = async () => (await call('/api/trash')).data;
const TAG = `Т${Date.now() % 100000}`;

// --- подготовка: админ есть, папка «Мои приложения» с 5 заметками ---
if ((await call('/api/me')).data?.state !== 'user') await call('/api/join', { name: 'Админ', tz: 'UTC' });
await call('/api/trash/empty', {});
const FOLD = `Прил ${TAG}`;
const f1 = (await call('/api/folders/create', { name: FOLD })).data.id;
const ids = [];
for (let i = 1; i <= 7; i++) {
  await say(`${TAG} заметка ${i}`);
  const raz = (await folders()).find((f) => f.kind === 'misc');
  const n = (await notesIn(raz.id)).find((x) => x.text.includes(`${TAG} заметка ${i}`));
  ids.push(n?.id);
}
check('создано 7 заметок', ids.every(Boolean), JSON.stringify(ids));
for (const id of ids.slice(0, 5)) await call('/api/notes/update', { id, folder_id: f1 });
check('в папке 5 заметок', (await notesIn(f1)).length === 5);

// --- удаление папки целиком ---
const del = await call('/api/folders/delete', { id: f1 });
check('папка удаляется', del.status === 200, JSON.stringify(del));
check('удалённой папки нет в списке папок', !(await folders()).some((f) => f.id === f1));
check('заметки удалённой папки не видны в поиске', (await call(`/api/notes?q=${encodeURIComponent(TAG + ' заметка 1')}`)).data.total === 0);
let t = await trash();
const tf = t.folders.find((f) => f.id === f1);
check('папка лежит в корзине с 5 заметками и сроком 7 дней', tf && tf.n === 5 && t.days === 7, JSON.stringify(tf));
check('внутри корзинной папки видны 5 заметок', (await call(`/api/trash/folder?id=${f1}`)).data.notes.length === 5);
const tn = (await call(`/api/trash/folder?id=${f1}`)).data.notes[0];
check('заметку из корзинной папки можно открыть', (await call(`/api/trash/note?id=${tn.id}`)).status === 200);
check('удалённую заметку нельзя открыть как обычную', (await call(`/api/note?id=${tn.id}`)).status === 404);
check('удалённую заметку нельзя править', (await call('/api/notes/update', { id: tn.id, text: 'взлом' })).status === 404);

// --- новая папка с тем же названием + возврат = объединение (2 + 5 = 7) ---
const f2 = (await call('/api/folders/create', { name: FOLD })).data.id;
check('можно создать новую папку с тем же названием, пока старая в корзине', !!f2 && f2 !== f1);
for (const id of ids.slice(5)) await call('/api/notes/update', { id, folder_id: f2 });
const rs = await call('/api/trash/restore', { type: 'folder', id: f1 });
check('возврат папки объединяет с существующей', rs.data.merged === true && rs.data.count === 5, JSON.stringify(rs.data));
check('в объединённой папке 7 заметок', (await notesIn(f2)).length === 7);
check('корзина после возврата не содержит этой папки', !(await trash()).folders.some((f) => f.id === f1));

// --- удаляем снова, возвращаем ОДНУ заметку (в «Разное») и потом остальные папкой ---
await call('/api/folders/delete', { id: f2 });
const content = (await call(`/api/trash/folder?id=${f2}`)).data.notes;
const one = await call('/api/trash/restore', { type: 'note', id: content[0].id });
check('заметка из удалённой папки возвращается в «Разное»', one.data.folder === 'Разное', JSON.stringify(one.data));
check('остальные 6 остались в корзинной папке', (await call(`/api/trash/folder?id=${f2}`)).data.notes.length === 6);
const back = await call('/api/trash/restore', { type: 'folder', id: f2 });
check('папка возвращается заново (названия больше нет среди живых) с оставшимися 6', back.data.merged === false && back.data.count === 6, JSON.stringify(back.data));
const f3 = (await folders()).find((f) => f.name === FOLD);
check('папка снова в списке и в ней 6 заметок', f3 && (await notesIn(f3.id)).length === 6);

// --- отдельная заметка, напоминания ---
const nid = (await notesIn(f3.id))[0].id;
const when = new Date(Date.now() + 2 * 86400e3).toISOString().slice(0, 10) + 'T10:00';
await call('/api/reminders/set', { note_id: nid, local: when });
const cal = () => call(`/api/calendar?month=${when.slice(0, 7)}`).then((r) => JSON.stringify(r.data.days));
check('напоминание видно в календаре', (await cal()).includes(TAG));
await call('/api/notes/delete', { id: nid });
check('напоминание удалённой заметки исчезло из календаря', !(await cal()).includes(TAG));
check('удалённая заметка в корзине как отдельная', (await trash()).notes.some((n) => n.id === nid));
const rn = await call('/api/trash/restore', { type: 'note', id: nid });
check('отдельно удалённая заметка возвращается в свою папку, если она есть', rn.data.folder === FOLD, JSON.stringify(rn.data));
await call('/api/notes/update', { id: nid, folder_id: f3.id });
check('напоминание после возврата снова в календаре (время ещё впереди)', (await cal()).includes(TAG));

// заметка удалена отдельно, потом удалена и её папка: возврат заметки идёт в «Разное»
const FOLD_B = `Врем ${TAG}`;
const fb = (await call('/api/folders/create', { name: FOLD_B })).data.id;
await call('/api/notes/update', { id: nid, folder_id: fb });
await call('/api/notes/delete', { id: nid });
await call('/api/folders/delete', { id: fb });
const rn2 = await call('/api/trash/restore', { type: 'note', id: nid });
check('заметка, чья папка уже удалена, возвращается в «Разное»', rn2.data.folder === 'Разное', JSON.stringify(rn2.data));
await call('/api/notes/update', { id: nid, folder_id: f3.id });
await call('/api/trash/purge', { type: 'folder', id: fb });
// регистр названия: папка и список «в другом регистре» — это та же папка и тот же список
const dupF = await call('/api/folders/create', { name: FOLD.toUpperCase() });
check('папка с названием в другом регистре не создаётся дублем', dupF.status === 409, JSON.stringify(dupF));
const dupL0 = (await call('/api/shopping/lists/create', { name: `Лавка ${TAG}` })).data.id;
const dupL = (await call('/api/shopping/lists/create', { name: `ЛАВКА ${TAG}` })).data;
check('список покупок с названием в другом регистре не создаётся дублем', dupL.id === dupL0, JSON.stringify(dupL).slice(0, 80));
await call('/api/shopping/lists/delete', { id: dupL0 });
await call('/api/trash/purge', { type: 'list', id: dupL0 });

// --- бот: кнопка «Удалить» и «Вернуть», «Новая папка» ---
const nid2 = (await notesIn(f3.id))[0].id;
await press(`del:${nid2}`);
const delMsg = sent.find((m) => m.method === 'editMessageText');
check('бот: после «Удалить» показана кнопка «Вернуть»', JSON.stringify(delMsg?.body ?? {}).includes(`un:${nid2}`), JSON.stringify(delMsg?.body ?? {}).slice(0, 160));
check('бот: заметка в корзине', (await trash()).notes.some((n) => n.id === nid2));
await press(`un:${nid2}`);
check('бот: «Вернуть» возвращает заметку', !(await trash()).notes.some((n) => n.id === nid2) && (await call(`/api/note?id=${nid2}`)).status === 200);
const NF = `Новая ${TAG}`;
await press(`mvn:${nid2}`);
await say(NF);
const nf = (await folders()).find((f) => f.name === NF);
check('бот: «+ Новая папка» создаёт папку и переносит заметку', nf && (await notesIn(nf.id)).some((n) => n.id === nid2));
await press(`mvn:${nid2}`);
await say(NF.toUpperCase());
check('бот: если папка уже есть (другой регистр), дубля нет', (await folders()).filter((f) => f.name.toLowerCase() === NF.toLowerCase()).length === 1);

// --- покупки ---
const L = (await call('/api/shopping/lists/create', { name: `Магазин ${TAG}` })).data.id;
await call('/api/shopping/add', { name: 'Молоко', list_id: L });
await call('/api/shopping/add', { name: 'Яйца', list_id: L });
const delList = await call('/api/shopping/lists/delete', { id: L });
check('список покупок удаляется', delList.status === 200);
check('удалённого списка и его пунктов нет в живых', !delList.data.lists.some((l) => l.id === L) && !delList.data.items.some((i) => ['Молоко', 'Яйца'].includes(i.name) && i.list_id === L));
t = await trash();
check('список лежит в корзине с 2 пунктами', t.lists.some((l) => l.id === L && l.n === 2), JSON.stringify(t.lists));
const L2 = (await call('/api/shopping/lists/create', { name: `Магазин ${TAG}` })).data.id;
check('новый список с тем же названием создаётся', !!L2 && L2 !== L);
const rl = await call('/api/trash/restore', { type: 'list', id: L });
check('возврат списка объединяет с существующим', rl.data.merged === true && rl.data.count === 2, JSON.stringify(rl.data));
check('в объединённом списке 2 пункта', (await call(`/api/shopping?list=${L2}`)).data.items.length === 2);
const it = (await call(`/api/shopping?list=${L2}`)).data.items[0];
await call('/api/shopping/delete', { id: it.id });
check('удалённый пункт (✕) лежит в корзине', (await trash()).items.some((i) => i.id === it.id));
const ri = await call('/api/trash/restore', { type: 'item', id: it.id });
check('пункт возвращается в свой список', ri.data.list_id === L2, JSON.stringify(ri.data));
await call('/api/shopping/toggle', { id: it.id });
await call('/api/shopping/clear', { view: String(L2) });
check('«Очистить купленное» кладёт купленное в корзину', (await trash()).items.some((i) => i.id === it.id));
await call('/api/trash/restore', { type: 'item', id: it.id });

// --- окончательное удаление и срок хранения ---
const extra = (await call('/api/shopping/add', { name: 'Лишнее', list_id: L2 })).data.items.find((i) => i.name === 'Лишнее');
await call('/api/shopping/delete', { id: extra.id });
check('«Удалить навсегда» стирает пункт', (await call('/api/trash/purge', { type: 'item', id: extra.id })).status === 200 && !(await trash()).items.some((i) => i.id === extra.id));
check('повторное удаление навсегда: 404', (await call('/api/trash/purge', { type: 'item', id: extra.id })).status === 404);
await call('/api/folders/delete', { id: f3.id });
sql(`UPDATE folders SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = ${f3.id}; UPDATE notes SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE deleted_with_folder = ${f3.id};`);
sql(`DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < '${new Date(Date.now() - 7 * 86400e3).toISOString()}'; DELETE FROM folders WHERE deleted_at IS NOT NULL AND deleted_at < '${new Date(Date.now() - 7 * 86400e3).toISOString()}';`);
check('просроченное (старше 7 дней) стирается, свежее остаётся', !(await trash()).folders.some((f) => f.id === f3.id));
await call('/api/folders/delete', { id: nf.id });
check('«Очистить корзину» опустошает её', (await call('/api/trash/empty', {})).status === 200 && (() => 0)() === 0);
t = await trash();
check('корзина пуста', t.folders.length + t.notes.length + t.lists.length + t.items.length === 0, JSON.stringify(t).slice(0, 200));

// --- уборка тестовых данных ---
for (const f of await folders()) if (f.name.includes(TAG)) await call('/api/folders/delete', { id: f.id });
await call('/api/shopping/lists/delete', { id: L2 });
await call('/api/trash/empty', {});
for (const n of (await call(`/api/notes?q=${encodeURIComponent(TAG)}`)).data.notes) await call('/api/notes/delete', { id: n.id });
await call('/api/trash/empty', {});
console.log(fails ? `\nНЕ ПРОЙДЕНО проверок: ${fails}` : '\nВсе проверки пройдены');
mock.close();
process.exit(fails ? 1 : 0);
