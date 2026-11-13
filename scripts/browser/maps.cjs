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
  // старое дерево создаём через API (в приложении новые карты теперь только доски)
  await page.evaluate(async (d) => { await fetch('/api/maps/create',{method:'POST',headers:{Authorization:'tma '+d,'content-type':'application/json'},body:JSON.stringify({tree:{id:'r1',topic:'Старое дерево',children:[{id:'c1',topic:'Документы',style:{background:'#e5484d',color:'#ffffff'}}]}})}); }, initData);
  await page.tap('[data-tab="maps"]'); await page.waitForSelector('.swrow');
  await page.tap('.swrow:has-text("Старое дерево") .swface'); await page.waitForSelector('me-root me-tpc'); await page.waitForTimeout(600);
  const bg = await page.evaluate(() => { const e=[...document.querySelectorAll('me-tpc')].find(x=>x.textContent.includes('Документы')); return e && [e.style.backgroundColor, e.style.color]; });
  console.log('REOPEN colors', JSON.stringify(bg));
  const before = await page.evaluate(()=>document.querySelectorAll('me-tpc').length);
  await page.tap('#mapFit'); await page.waitForTimeout(900);
  await page.tap('me-root me-tpc'); await page.tap('#mapChild'); await page.fill('#askIn','Паспорт'); await page.tap('#askYes'); await page.waitForTimeout(500);
  await page.tap('#mapUndo'); await page.waitForTimeout(500);
  console.log('AFTER UNDO nodes', await page.evaluate(()=>document.querySelectorAll('me-tpc').length), 'before', before);
  await page.tap('me-root me-tpc'); await page.tap('#mapDel'); await page.waitForSelector('#newMap'); await page.waitForTimeout(500);
  await b.close();
})();
