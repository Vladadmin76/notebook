// Сквозная проверка напоминаний «каждые N часов» с настойчивым режимом на запущенном npm run dev.
// В .dev.vars: DEEPSEEK_API_KEY=x, DEEPSEEK_API_ROOT=http://127.0.0.1:8099, TG_API_ROOT=http://127.0.0.1:8099 (заглушку скрипт поднимает сам).
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import http from 'node:http';

const env = Object.fromEntries(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').split('\n')
  .filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const BASE = process.argv[2] ?? 'http://localhost:8787';
const ADMIN = Number(env.ADMIN_TELEGRAM_ID);

// заглушка Telegram (с номерами сообщений) и DeepSeek
const log = [];
let msgSeq = 1000;
const root = new URL(env.TG_API_ROOT ?? 'http://127.0.0.1:8099');
const mock = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const raw = Buffer.concat(chunks).toString();
    if (req.url.endsWith('/chat/completions')) {
      const out = { notes: [{ text: 'Пить воду.', folder: 'Задачи', new_folder: false, remind: { at: null, in_minutes: null, repeat: null,
        interval: { every_minutes: 120, from: '00:00', to: '23:59', weekdays: [1, 2, 3, 4, 5, 6, 7], nag: true }, text: 'Попить воды' } }], shopping: [], request: null };
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
    }
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
    const method = req.url.split('/').pop();
    log.push({ method, body });
    if (method === 'sendMessage') return res.end(JSON.stringify({ ok: true, result: { message_id: ++msgSeq, date: 1, chat: { id: 1, type: 'private' } } }));
    res.end(JSON.stringify({ ok: true, result: true }));
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
const hook = (update) => fetch(BASE + '/tg/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': env.TG_WEBHOOK_SECRET }, body: JSON.stringify({ update_id: Math.floor(Math.random() * 1e9), ...update }) });
const tick = () => fetch(BASE + '/cron/tick', { headers: { 'X-Cron-Secret': env.CRON_SECRET } }).then((r) => r.json());
const sql = (q) => JSON.parse(execSync(`npx wrangler d1 execute notes_db --local --json --command "${q.replace(/"/g, '\\"')}" 2>/dev/null`, { cwd: new URL('..', import.meta.url).pathname }).toString().replace(/^[^\[]*/, ''))[0].results;
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); if (!ok) fails++; };
const sends = () => log.filter((m) => m.method === 'sendMessage');
const dels = () => log.filter((m) => m.method === 'deleteMessage');

if ((await call('/api/me')).data?.state !== 'user') await call('/api/join', { name: 'Админ', tz: 'UTC' });
sql(`UPDATE reminders SET status = 'cancelled', nag_active = 0 WHERE user_id = ${ADMIN} AND int_minutes IS NOT NULL`);

// --- создание голосом или текстом ---
log.length = 0;
await hook({ message: { message_id: 1, date: 1, chat: { id: ADMIN, type: 'private' }, from: { id: ADMIN, is_bot: false, first_name: 'T' }, text: 'напоминай пить воду каждые 2 часа' } });
for (let i = 0; i < 80 && !sends().length; i++) await wait(100);
await wait(500);
const [rem] = sql(`SELECT * FROM reminders WHERE user_id = ${ADMIN} AND int_minutes IS NOT NULL AND status = 'pending' ORDER BY id DESC LIMIT 1`);
check('напоминание «каждые 2 часа» создано', rem && rem.int_minutes === 120 && rem.win_from === '00:00' && rem.win_to === '23:59' && rem.int_days === '1,2,3,4,5,6,7' && rem.nag === 1, JSON.stringify(rem));
check('бот описал расписание и настойчивый режим', /каждые 2 часа/.test(sends()[0]?.body.text ?? '') && /каждую минуту/.test(sends()[0]?.body.text ?? ''), sends()[0]?.body.text);
const RID = rem?.id;

// --- срок наступил: сообщение с одной кнопкой «Готово», повторы включились, расписание не сдвинулось ---
log.length = 0;
sql(`UPDATE reminders SET remind_at = '2020-01-01T00:00:00.000Z' WHERE id = ${RID}`);
await tick();
const first = sends()[0];
check('в срок пришло сообщение с кнопкой «Готово»', first && /Попить воды/.test(first.body.text) && JSON.stringify(first.body.reply_markup).includes(`rd:${RID}`) && !JSON.stringify(first.body.reply_markup).includes('rs:'), JSON.stringify(first?.body));
const [r1] = sql(`SELECT * FROM reminders WHERE id = ${RID}`);
check('следующий срок стоит по расписанию, повторы включены', r1.nag_active === 1 && r1.nag_msg > 1000 && r1.remind_at > new Date().toISOString() && r1.nag_next > new Date().toISOString() && r1.nag_until > r1.nag_next, JSON.stringify(r1));
const slotAfter = r1.remind_at;

// --- повтор через минуту: старое сообщение удаляется, приходит новое ---
log.length = 0;
const firstMsg = r1.nag_msg;
sql(`UPDATE reminders SET nag_next = '2020-01-01T00:00:00.000Z' WHERE id = ${RID}`);
await tick();
const [r2] = sql(`SELECT * FROM reminders WHERE id = ${RID}`);
check('повтор: прежнее сообщение удалено', dels().some((d) => d.body.message_id === firstMsg), JSON.stringify(log.map((l) => l.method + ':' + (l.body.message_id ?? ''))));
check('повтор: пришло новое сообщение, номер сохранён', sends().length === 1 && r2.nag_msg !== firstMsg && r2.nag_msg > 1000, JSON.stringify(r2));
check('повтор не сдвигает расписание', r2.remind_at === slotAfter);
log.length = 0;
await tick(); // минута ещё не прошла
check('раньше времени повтора нет', sends().length === 0 && dels().length === 0);

// --- «Готово»: повторы прекращаются, сообщение удаляется, расписание то же ---
log.length = 0;
await hook({ callback_query: { id: 'cb1', from: { id: ADMIN, is_bot: false, first_name: 'T' }, chat_instance: 'x', data: `rd:${RID}`,
  message: { message_id: r2.nag_msg, date: 1, chat: { id: ADMIN, type: 'private' }, text: '🔔 Напоминание: Попить воды' } } });
await wait(1200);
const [r3] = sql(`SELECT * FROM reminders WHERE id = ${RID}`);
check('«Готово»: повторы остановлены', r3.nag_active === 0, JSON.stringify(r3));
check('«Готово»: сообщение удалено', dels().some((d) => d.body.message_id === r2.nag_msg), JSON.stringify(log.map((l) => l.method)));
check('«Готово»: следующий срок не сдвинулся', r3.remind_at === slotAfter);
log.length = 0;
sql(`UPDATE reminders SET nag_next = '2020-01-01T00:00:00.000Z' WHERE id = ${RID}`);
await tick();
check('после «Готово» повторов нет', sends().length === 0);

// --- следующий срок расписания: новое сообщение, старые повторы закончились ---
log.length = 0;
sql(`UPDATE reminders SET nag_active = 1, nag_msg = 5555, nag_next = '2099-01-01T00:00:00.000Z', remind_at = '2020-01-01T00:00:00.000Z' WHERE id = ${RID}`);
await tick();
const [r4] = sql(`SELECT * FROM reminders WHERE id = ${RID}`);
check('новый срок: прежнее сообщение заменено новым', dels().some((d) => d.body.message_id === 5555) && sends().length === 1 && r4.nag_active === 1, JSON.stringify(log.map((l) => l.method)));

// --- повторы не бесконечны: до конца шага расписания ---
log.length = 0;
sql(`UPDATE reminders SET nag_active = 1, nag_next = '2020-01-01T00:00:00.000Z', nag_until = '2020-01-01T00:01:00.000Z' WHERE id = ${RID}`);
await tick();
const [r5] = sql(`SELECT * FROM reminders WHERE id = ${RID}`);
check('по истечении шага расписания повторы прекращаются', r5.nag_active === 0 && sends().length === 0, JSON.stringify(r5));

// --- выключенный настойчивый режим: одно сообщение без повторов ---
log.length = 0;
sql(`UPDATE reminders SET nag = 0, nag_active = 0, remind_at = '2020-01-01T00:00:00.000Z' WHERE id = ${RID}`);
await tick();
const [r6] = sql(`SELECT * FROM reminders WHERE id = ${RID}`);
check('без настойчивого режима: одно сообщение, повторов нет', sends().length === 1 && r6.nag_active === 0, JSON.stringify(r6));

// --- приложение: поставить и прочитать расписание ---
const note = (await call('/api/notes')).data.notes?.[0];
const set = await call('/api/reminders/set', { note_id: note.id, interval: { every_minutes: 60, from: '08:00', to: '20:00', weekdays: [1, 2, 3, 4, 5, 6], nag: true } });
check('приложение: расписание сохраняется и читается', set.status === 200 && set.data.reminder.interval?.every_minutes === 60 && /каждый час, с 8:00 до 20:00, с понедельника по субботу/.test(set.data.reminder.interval.text), JSON.stringify(set.data));
const bad = await call('/api/reminders/set', { note_id: note.id, interval: { every_minutes: 'abc' } });
check('приложение: негодное расписание отклоняется', bad.status === 400);
await call('/api/reminders/cancel', { note_id: note.id });
sql(`UPDATE reminders SET status = 'cancelled', nag_active = 0 WHERE user_id = ${ADMIN} AND int_minutes IS NOT NULL`);
console.log(fails ? `\nНЕ ПРОЙДЕНО проверок: ${fails}` : '\nВсе проверки пройдены');
mock.close();
process.exit(fails ? 1 : 0);
