// Сквозная проверка магазинов на запущенном локально приложении (npm run dev).
// Нужно в .dev.vars: DEEPSEEK_API_KEY=x, DEEPSEEK_API_ROOT=http://127.0.0.1:8099 (заглушку DeepSeek и Telegram скрипт поднимает сам), TG_API_ROOT=http://127.0.0.1:8099
// Запуск: npm run check:stores
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import http from 'node:http';

const env = Object.fromEntries(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').split('\n')
  .filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const BASE = process.argv[2] ?? 'http://localhost:8787';
const ADMIN = Number(env.ADMIN_TELEGRAM_ID);
const TAG = `Т${Date.now() % 100000}`;

// заглушка Telegram + DeepSeek
const sent = [];
const root = new URL(env.TG_API_ROOT ?? 'http://127.0.0.1:8099');
const mock = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const raw = Buffer.concat(chunks).toString();
    if (req.url.endsWith('/chat/completions')) {
      const n = JSON.parse(JSON.parse(raw).messages[1].content).note;
      let out = { notes: [{ text: n, folder: 'Идеи', new_folder: false, remind: null }], shopping: [], request: null };
      let m;
      if ((m = /в (Харбор Фрейт|Хомдепот|Магазин\S+) (\S+)/.exec(n))) out = { notes: [], shopping: [{ name: m[2][0].toUpperCase() + m[2].slice(1), store: m[1] }], request: null };
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
    }
    try { sent.push({ method: req.url.split('/').pop(), body: JSON.parse(raw || '{}') }); } catch {}
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const say = async (text) => {
  sent.length = 0;
  await fetch(BASE + '/tg/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': env.TG_WEBHOOK_SECRET },
    body: JSON.stringify({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: 1, date: 1, chat: { id: ADMIN, type: 'private' }, from: { id: ADMIN, is_bot: false, first_name: 'T' }, text } }) });
  const t0 = Date.now(); while (Date.now() - t0 < 8000 && !sent.some((m) => m.method === 'sendMessage')) await wait(100);
  await wait(400);
};
const sql = (q) => execSync(`npx wrangler d1 execute notes_db --local --command "${q.replace(/"/g, '\\"')}" 2>&1`, { cwd: new URL('..', import.meta.url).pathname }).toString();

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); if (!ok) fails++; };
const stores = async () => (await call('/api/stores')).data.stores;
const store = async (n) => (await stores()).find((s) => s.name === n);
const lists = async () => (await call('/api/shopping')).data.lists;
const list = async (n) => (await lists()).find((l) => l.name === n);

// приводим стенд в чистое состояние для проверяемых магазинов
async function reset(name) {
  const l = await list(name);
  if (l) { for (const i of (await call(`/api/shopping?list=${l.id}`)).data.items) await call('/api/shopping/delete', { id: i.id }); }
  await call('/api/trash/empty', {});
  const st = await store(name);
  if (st?.favorite) await call('/api/stores/favorite', { name, favorite: false });
  sql(`UPDATE user_stores SET aliases='[]' WHERE name='${name}' AND custom=0`); // выученные написания прошлых прогонов
}
if ((await call('/api/me')).data?.state !== 'user') await call('/api/join', { name: 'Админ', tz: 'UTC' });
for (const n of ['Harbor Freight', 'The Home Depot', 'Kroger']) await reset(n);

// --- избранное создаёт список; убрать можно только пустой ---
await call('/api/stores/favorite', { name: 'Harbor Freight', favorite: true });
check('звёздочка создаёт список магазина', !!(await list('Harbor Freight')));
const HF = (await list('Harbor Freight')).id;
await call('/api/shopping/add', { name: 'Отвёртка', list_id: HF });
const blocked = await call('/api/stores/favorite', { name: 'Harbor Freight', favorite: false });
check('снять звёздочку при непустом списке нельзя (409 not_empty)', blocked.status === 409 && blocked.data.error === 'not_empty' && blocked.data.count === 1, JSON.stringify(blocked));
check('после отказа звёздочка и список на месте', (await store('Harbor Freight')).favorite === true && !!(await list('Harbor Freight')));
const blockedDel = await call('/api/shopping/lists/delete', { id: HF });
check('убрать магазин кнопкой «Убрать магазин» при пунктах тоже нельзя', blockedDel.status === 409);
check('даже купленное считается: очистить купленное, но пункты остались, не удалить', (await call('/api/stores/favorite', { name: 'Harbor Freight', favorite: false })).status === 409);
const it = (await call(`/api/shopping?list=${HF}`)).data.items[0];
await call('/api/shopping/toggle', { id: it.id });
check('купленный пункт всё ещё блокирует удаление списка', (await call('/api/stores/favorite', { name: 'Harbor Freight', favorite: false })).status === 409);
await call('/api/shopping/clear', { view: String(HF) });
const freed = await call('/api/stores/favorite', { name: 'Harbor Freight', favorite: false });
check('после очистки звёздочка снимается', freed.status === 200 && (await store('Harbor Freight')).favorite === false);
check('пустой список исчез вместе со звёздочкой', !(await list('Harbor Freight')));

// --- бот: известный магазин по русскому названию, даже не избранный ---
await say('в Харбор Фрейт отвёртки');
check('«Харбор Фрейт» узнан как Harbor Freight, магазин стал избранным и получил список', (await store('Harbor Freight')).favorite === true && !!(await list('Harbor Freight')));
check('покупка попала в этот список', (await call(`/api/shopping?list=${(await list('Harbor Freight')).id}`)).data.items.some((i) => i.name === 'Отвёртки'));
check('бот сообщил о новом избранном магазине', JSON.stringify(sent).includes('В избранные магазины добавлен'), JSON.stringify(sent).slice(0, 200));

// --- бот: незнакомый магазин становится своим избранным ---
const CUSTOM = `Магазин${TAG}`;
await say(`в ${CUSTOM} хлеб`);
const cs = await store(CUSTOM);
check('новый магазин из речи добавлен в «Магазины» как свой избранный', cs && cs.custom && cs.favorite, JSON.stringify(cs));
check('и у него есть список с покупкой', !!(await list(CUSTOM)));

// --- строго к не избранным, снисходительно к избранным ---
await say('в Хомдепот гвозди');
check('опечатка в НЕ избранном магазине не превращается в Home Depot (строго)', !(await list('The Home Depot')) && !!(await list('Хомдепот')), JSON.stringify((await lists()).map((l) => l.name)));
await call('/api/shopping/lists/delete', { id: (await list('Хомдепот')).id }).catch(() => {});
const hd = await list('Хомдепот');
if (hd) { for (const i of (await call(`/api/shopping?list=${hd.id}`)).data.items) await call('/api/shopping/delete', { id: i.id }); await call('/api/shopping/lists/delete', { id: hd.id }); }
await call('/api/stores/favorite', { name: 'The Home Depot', favorite: true });
await say('в Хомдепот шурупы');
check('у избранного Home Depot та же опечатка узнаётся (снисходительно)', (await call(`/api/shopping?list=${(await list('The Home Depot')).id}`)).data.items.some((i) => i.name === 'Шурупы') && !(await list('Хомдепот')));

// --- переименование и удаление ---
const ren = await call('/api/shopping/lists/rename', { id: (await list('Harbor Freight')).id, name: 'Другое' });
check('название магазина из перечня менять нельзя', ren.status === 400);
const ren2 = await call('/api/shopping/lists/rename', { id: (await list(CUSTOM)).id, name: `Рынок${TAG}` });
check('свой магазин переименовывается вместе со списком', ren2.status === 200 && !!(await list(`Рынок${TAG}`)) && !!(await store(`Рынок${TAG}`)) && !(await store(CUSTOM)));

// --- старые списки без магазина становятся избранными ---
sql(`INSERT INTO shopping_lists (user_id, name, created_at) VALUES (${ADMIN}, 'Kroger', '2026-01-01T00:00:00.000Z'), (${ADMIN}, 'Старый${TAG}', '2026-01-01T00:00:00.000Z')`);
const sync = await stores();
check('старый список из перечня («Kroger») стал избранным магазином из перечня', sync.find((s) => s.name === 'Kroger')?.favorite === true && !sync.find((s) => s.name === 'Kroger').custom);
check('старый свой список стал своим избранным магазином', sync.find((s) => s.name === `Старый${TAG}`)?.custom === true);

// --- уборка ---
for (const n of ['Harbor Freight', 'The Home Depot', 'Kroger', `Рынок${TAG}`, `Старый${TAG}`]) await reset(n).catch(() => {});
for (const l of await lists()) if (l.name.includes(TAG)) { for (const i of (await call(`/api/shopping?list=${l.id}`)).data.items) await call('/api/shopping/delete', { id: i.id }); await call('/api/shopping/lists/delete', { id: l.id }); }
await call('/api/trash/empty', {});
console.log(fails ? `\nНЕ ПРОЙДЕНО проверок: ${fails}` : '\nВсе проверки пройдены');
mock.close();
process.exit(fails ? 1 : 0);
