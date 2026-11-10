import { webhookCallback } from 'grammy';
import { createBot } from './bot.js';
import * as db from './db.js';
import { json, isValidTz } from './util.js';

let cached; // Bot переиспользуется между запросами одного изолята
function getHandler(env) {
  if (!cached || cached.token !== env.TG_BOT_TOKEN) {
    const bot = createBot(env);
    cached = {
      token: env.TG_BOT_TOKEN,
      handle: webhookCallback(bot, 'cloudflare-mod', { secretToken: env.TG_WEBHOOK_SECRET }),
    };
  }
  return cached.handle;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- Telegram webhook ---
    if (path === '/tg/webhook' && request.method === 'POST') {
      return getHandler(env)(request); // секрет проверяет grammY (401 при несовпадении)
    }

    // --- Внешний таймер (этап 4) ---
    if (path === '/cron/tick') {
      if (request.headers.get('X-Cron-Secret') !== env.CRON_SECRET) return new Response('Forbidden', { status: 403 });
      return json({ sent: 0 });
    }

    // --- Страница приглашения ---
    const joinPage = path.match(/^\/join\/([\w-]{20,})$/);
    if (joinPage && request.method === 'GET') {
      const page = await env.ASSETS.fetch(new URL('/join.html', url));
      return new Response(page.body, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
      });
    }

    const joinApi = path.match(/^\/api\/join\/([\w-]{20,})(\/claim)?$/);
    if (joinApi) {
      const inv = await db.getInvite(env.DB, joinApi[1]);
      const state = db.inviteState(inv);

      if (!joinApi[2] && request.method === 'GET') {
        return json({ state, label: state === 'open' ? inv.label : undefined });
      }
      if (joinApi[2] && request.method === 'POST') {
        // Защита от чужих сайтов: принимаем только запросы с нашей страницы
        if (request.headers.get('Origin') !== url.origin) return json({ error: 'forbidden' }, 403);
        if (state !== 'open') return json({ error: state }, 409);
        const body = await request.json().catch(() => ({}));
        if (!isValidTz(body.tz)) return json({ error: 'bad_tz' }, 400);
        const token = await db.claimInvite(env.DB, joinApi[1], body.tz);
        return json({ botUrl: `https://t.me/${env.BOT_USERNAME}?start=${token}` });
      }
      return json({ error: 'method' }, 405);
    }

    if (path === '/') return new Response('Блокнот', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return env.ASSETS.fetch(request); // остальная статика (style.css и т.д.)
  },
};
