// Проверка в браузере с касаниями: режим соединения (нить от точки, второй палец двигает доску). Запуск: npm run check:maps
const { chromium } = require('playwright');
const { readFileSync } = require('fs');
const { createHmac } = require('crypto');
const env = Object.fromEntries(readFileSync(require('path').join(__dirname,'../../.dev.vars'),'utf8').split('\n').filter(l=>l.includes('=')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now()/1000)), user: JSON.stringify({ id: Number(env.ADMIN_TELEGRAM_ID), first_name: 'A' }) });
const dcs = [...p.entries()].map(([k,v])=>`${k}=${v}`).sort().join('\n');
p.set('hash', createHmac('sha256', createHmac('sha256','WebAppData').update(env.TG_BOT_TOKEN).digest()).update(dcs).digest('hex'));
const initData = p.toString();
const OUT = require('os').tmpdir() + '/';
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 700, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  page.on('console', m => { if (m.type()==='error') console.log('CONSOLE', m.text()); });
  await page.route('https://telegram.org/**', r => r.abort());
  await page.addInitScript((d) => { window.Telegram = { WebApp: { initData: d, initDataUnsafe: {}, ready(){}, expand(){}, colorScheme:'light', onEvent(){}, BackButton:{show(){},hide(){},onClick(){}}, showConfirm:(t,cb)=>cb(true), showAlert(){} } }; }, initData);
  await page.goto('http://localhost:8787/');
  await page.waitForSelector('[data-tab="maps"]');
  const api = (path, body) => page.evaluate(async ([d, path, body]) => (await (await fetch(path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'tma ' + d, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json()), [initData, path, body]);
  const nd = (id, x, y, topic) => ({ id, x, y, topic });
  const created = await api('/api/maps/create', { board: { nodes: [nd('a',0,0,'Один'), nd('b',260,0,'Два'), nd('c',520,0,'Три'), nd('d',260,160,'Четыре')], edges: [] } });
  await page.tap('[data-tab="maps"]'); await page.waitForSelector('.swrow');
  await page.tap('.swrow:has-text("Один") .swface'); await page.waitForSelector('.bnode'); await page.waitForTimeout(700);
  const cdp = await ctx.newCDPSession(page);
  const T = (t) => '.bnode:text-is("' + t + '")';
  const ctr = async (sel) => { const r = await page.locator(sel).first().boundingBox(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
  const wait = (ms) => page.waitForTimeout(ms);
  // вход в режим соединения: удержание окошка → «Добавить точки»
  { const c = await ctr(T('Один')); await touch('touchStart', [{ x: c.x, y: c.y, id: 1 }]); await wait(750); await touch('touchEnd', []); await wait(650); }
  await page.tap('#nLink'); await wait(400);
  console.log('DOTS', await page.evaluate(() => document.querySelectorAll('.bdot').length), 'stop button', await page.evaluate(() => !!document.getElementById('bStop')));
  const dotOf = async (t) => { const r = await page.locator('.bnode:text-is("' + t + '") .bdot').boundingBox(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  const edgesNow = async () => { await wait(1100); const l = (await api('/api/maps')).maps; const g = await api('/api/maps/get?id=' + created.id); return g.data.edges.map(e => e.from + '>' + e.to).sort().join(','); };
  // 1. обычная нить: Один → Два
  { const a = await dotOf('Один'), b = await ctr(T('Два')); await touch('touchStart', [{ x: a.x, y: a.y, id: 1 }]);
    for (let i = 1; i <= 10; i++) { await touch('touchMove', [{ x: a.x + (b.x - a.x) * i / 10, y: a.y + (b.y - a.y) * i / 10, id: 1 }]); await wait(25); }
    console.log('HIGHLIGHT', await page.evaluate(() => document.querySelectorAll('.bnode.drop').length));
    await touch('touchEnd', []); await wait(300); }
  console.log('EDGES1', await edgesNow());
  // 2. повторная нить между той же парой (в обратную сторону) не создаётся
  { const a = await dotOf('Два'), b = await ctr(T('Один')); await touch('touchStart', [{ x: a.x, y: a.y, id: 1 }]);
    for (let i = 1; i <= 10; i++) { await touch('touchMove', [{ x: a.x + (b.x - a.x) * i / 10, y: a.y + (b.y - a.y) * i / 10, id: 1 }]); await wait(25); }
    await touch('touchEnd', []); await wait(300); }
  console.log('TOAST', await page.evaluate(() => document.querySelector('.toast')?.textContent));
  console.log('EDGES2', await edgesNow());
  // 3. нить первым пальцем + второй палец двигает доску: «Четыре» подъезжает под первый палец
  { const a = await dotOf('Один'), P = { x: 330, y: 640 }, d = await ctr(T('Четыре'));
    const dx = P.x - d.x, dy = P.y - d.y;
    await touch('touchStart', [{ x: a.x, y: a.y, id: 1 }]);
    for (let i = 1; i <= 6; i++) { await touch('touchMove', [{ x: a.x + (P.x - a.x) * i / 6, y: a.y + (P.y - a.y) * i / 6, id: 1 }]); await wait(25); }
    const f2 = { x: 600, y: 300 };
    await touch('touchStart', [{ x: P.x, y: P.y, id: 1 }, { x: f2.x, y: f2.y, id: 2 }]);
    for (let i = 1; i <= 10; i++) await touch('touchMove', [{ x: P.x, y: P.y, id: 1 }, { x: f2.x + dx * i / 10, y: f2.y + dy * i / 10, id: 2 }]), await wait(25);
    console.log('HIGHLIGHT2', await page.evaluate(() => [...document.querySelectorAll('.bnode.drop')].map(e => e.textContent.replace(/\s/g, ''))));
    await touch('touchMove', [{ x: P.x, y: P.y, id: 1 }]); await wait(150); // второй палец поднят, первый держит нить
    console.log('THREAD still in hand', await page.evaluate(() => document.getElementById('bthread').innerHTML.length > 0));
    await touch('touchEnd', []); await wait(300); }
  console.log('EDGES3', await edgesNow());
  // 4. окошки в режиме замерли
  const before = await page.evaluate(() => document.querySelector('.bnode:nth-child(3)').style.left);
  { const c = await ctr(T('Три')); await touch('touchStart', [{ x: c.x, y: c.y, id: 1 }]);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', [{ x: c.x, y: c.y - 8 * i, id: 1 }]); await wait(20); } await touch('touchEnd', []); await wait(300); }
  console.log('FROZEN', (await api('/api/maps/get?id=' + created.id)).data.nodes.find(n => n.id === 'c').y === 0);
  // 5. «Стоп»
  await page.tap('#bStop'); await wait(300);
  console.log('STOP dots', await page.evaluate(() => document.querySelectorAll('.bdot').length), 'fit button', await page.evaluate(() => !!document.getElementById('bFit')));
  await api('/api/maps/delete', { id: created.id });
  await b.close();
})();
