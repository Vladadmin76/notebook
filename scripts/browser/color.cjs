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
  const ctx = await b.newContext({ viewport: { width: 700, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  page.on('console', m => { if (m.type()==='error') console.log('CONSOLE', m.text()); });
  await page.route('https://telegram.org/**', r => r.abort());
  await page.addInitScript((d) => { window.Telegram = { WebApp: { initData: d, initDataUnsafe: {}, ready(){}, expand(){}, colorScheme:'light', onEvent(){}, BackButton:{show(){},hide(){},onClick(){}}, showConfirm:(t,cb)=>cb(true), showAlert(){} } }; }, initData);
  await page.goto('http://localhost:8787/');
  await page.waitForSelector('[data-tab="maps"]'); await page.tap('[data-tab="maps"]');
  await page.waitForSelector('#newMap'); await page.tap('#newMap');
  await page.tap('#kBoard'); await page.waitForSelector('#mapPlusB'); await page.tap('#mapPlusB');
  await page.fill('#askIn','Идея'); await page.tap('#askYes'); await page.waitForSelector('.bnode');
  { const cdp = await ctx.newCDPSession(page); const r = await page.locator('.bnode').first().boundingBox(); const x = r.x + r.width/2, y = r.y + r.height/2;
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]}); await page.waitForTimeout(750); await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}); await page.waitForTimeout(650); }
  console.log('MENU items', await page.evaluate(()=>[...document.querySelectorAll('.modal button')].map(b=>b.textContent).join('|')));
  await page.tap('#nColor'); await page.waitForTimeout(300);
  console.log('DBG', await page.evaluate(()=>[document.querySelector('.modal')?.outerHTML.slice(0,200), document.querySelector('.toast')?.textContent, typeof pickColor]));
  console.log('SWATCHES', await page.evaluate(()=>document.querySelectorAll('.sw').length));
  await page.tap('.sw[data-c="#e5484d"]'); await page.waitForTimeout(500);
  console.log('NODE', await page.evaluate(()=>{const e=document.querySelector('.bnode');return [e.style.background,e.style.color];}));
  await page.screenshot({ path: OUT+'c1.png' });
  await b.close();
})();
