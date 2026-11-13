// Проверка в браузере с касаниями (нужны npm run dev и playwright). Запуск: npm run check:maps
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
  const ctx = await b.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  page.on('console', m => { if (m.type()==='error') console.log('CONSOLE', m.text()); });
  await page.route('https://telegram.org/**', r => r.abort());
  await page.addInitScript((d) => { window.Telegram = { WebApp: { initData: d, initDataUnsafe: {}, ready(){}, expand(){}, colorScheme:'light', onEvent(){}, BackButton:{show(){},hide(){},onClick(){}}, showConfirm:(t,cb)=>cb(true), showAlert(){} } }; }, initData);
  await page.goto('http://localhost:8787/');
  await page.waitForSelector('[data-tab="maps"]');
  const mk = (t) => page.evaluate(async ([d,t]) => (await (await fetch('/api/maps/create',{method:'POST',headers:{Authorization:'tma '+d,'content-type':'application/json'},body:JSON.stringify({board:{nodes:[{id:'a',x:0,y:0,topic:t}],edges:[]}})})).json()).id, [initData,t]);
  const count = () => page.evaluate(async (d) => (await (await fetch('/api/maps',{headers:{Authorization:'tma '+d}})).json()).maps.length, initData);
  await mk('Первая'); await mk('Вторая');
  await page.tap('[data-tab="maps"]'); await page.waitForSelector('.swrow');
  const cdp = await ctx.newCDPSession(page);
  const tp = (type,x,y) => cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y,id:1}]});
  const n0 = await count();
  const box = await page.locator('.swrow').first().boundingBox();
  const y = box.y + box.height/2, x0 = box.x + box.width - 40;
  await tp('touchStart', x0, y); for (let i=1;i<=8;i++){ await tp('touchMove', x0 - i*15, y); await page.waitForTimeout(20);} await tp('touchEnd'); await page.waitForTimeout(400);
  console.log('SWIPE open:', await page.evaluate(()=>document.querySelector('.swrow').classList.contains('open')), 'still on list:', await page.evaluate(()=>!!document.querySelector('#maplist')));
  await page.screenshot({ path: OUT+'l1.png' });
  await page.tap('.swrow.open .swdel'); await page.waitForTimeout(500);
  await page.waitForTimeout(800);
  console.log('DELETED by swipe:', n0 - await count());
  // удержание
  const box2 = await page.locator('.swrow').first().boundingBox();
  await tp('touchStart', box2.x+100, box2.y+box2.height/2); await page.waitForTimeout(750); await tp('touchEnd'); await page.waitForTimeout(400);
  console.log('HOLD open:', await page.evaluate(()=>document.querySelector('.swrow').classList.contains('open')), 'still on list:', await page.evaluate(()=>!!document.querySelector('#maplist')));
  // нажатие по открытой закрывает, не открывая карту
  await page.tap('.swrow.open .swface'); await page.waitForTimeout(400);
  console.log('TAP on open closes:', await page.evaluate(()=>!document.querySelector('.swrow.open')), 'still on list:', await page.evaluate(()=>!!document.querySelector('#maplist')));
  // обычное нажатие открывает карту
  await page.tap('.swrow .swface'); await page.waitForTimeout(800);
  console.log('TAP opens map:', await page.evaluate(()=>!!document.querySelector('#bbox')));
  await b.close();
})();
