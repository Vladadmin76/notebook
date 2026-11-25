// Проверка в браузере: вход по приглашению сразу подключает бота (одно нажатие). Запуск: npm run check:maps
const { chromium } = require('playwright');
const { readFileSync } = require('fs');
const { createHmac } = require('crypto');
const http = require('http');
const env = Object.fromEntries(readFileSync(require('path').join(__dirname, '../../.dev.vars'), 'utf8').split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const ADMIN = Number(env.ADMIN_TELEGRAM_ID);
const BASE = 'http://localhost:8787';
const sign = (user) => {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) });
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  p.set('hash', createHmac('sha256', createHmac('sha256', 'WebAppData').update(env.TG_BOT_TOKEN).digest()).update(dcs).digest('hex'));
  return p.toString();
};
const call = async (initData, path, body) => {
  const r = await fetch(BASE + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', Authorization: 'tma ' + initData }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
// заглушка Telegram Bot API (приветствие уходит сюда)
const root = new URL(env.TG_API_ROOT ?? 'http://127.0.0.1:8099');
const mock = http.createServer((req, res) => { req.on('data', () => {}); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: 'private' } } })); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await new Promise((r) => mock.once('error', r).listen(Number(root.port), root.hostname, r)).catch(() => {});
  const adminData = sign({ id: ADMIN, first_name: 'A' });
  const b = await chromium.launch();
  const scenario = async (id, allowsWrite, answer, name) => {
    const inv = (await call(adminData, '/api/admin/invite', { note: 'проверка входа' })).data.code;
    const user = { id, first_name: 'Тест', ...(allowsWrite ? { allows_write_to_pm: true } : {}) };
    const initData = sign(user);
    const ctx = await b.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    await page.route('https://telegram.org/**', (r) => r.abort());
    await page.addInitScript(([d, user, inv, answer]) => {
      window.__wa = 0;
      window.Telegram = { WebApp: { initData: d, initDataUnsafe: { user, start_param: inv }, ready() {}, expand() {}, colorScheme: 'light', onEvent() {}, BackButton: { show() {}, hide() {}, onClick() {} },
        requestWriteAccess(cb) { window.__wa++; setTimeout(() => cb(answer), 200); } } };
    }, [initData, user, inv, answer]);
    await page.goto(BASE + '/');
    await page.waitForSelector('#go');
    await page.fill('#name', name);
    await page.tap('#go');
    await page.waitForSelector('[data-tab="notes"]');
    let me = null;
    for (let i = 0; i < 20; i++) { me = (await call(initData, '/api/me')).data.user; if (me && me.can_write) break; await wait(200); }
    const calls = await page.evaluate(() => window.__wa);
    await ctx.close();
    await call(adminData, '/api/admin/remove', { id });
    return { calls, can_write: !!(me && me.can_write), entered: !!me };
  };
  const T = Date.now() % 10000;
  const a = await scenario(900003, false, true, `Анна${T}`);
  console.log('ALLOW', JSON.stringify(a));
  const c = await scenario(900005, false, false, `Борис${T}`);
  console.log('DENY', JSON.stringify(c));
  const d = await scenario(900004, true, true, `Вера${T}`);
  console.log('KNOWN', JSON.stringify(d));
  await b.close(); mock.close();
})();
