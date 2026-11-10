import { webhookCallback } from 'grammy';
import { createBot } from './bot.js';
import * as db from './db.js';
import { validateInitData } from './auth.js';
import { json, isValidTz } from './util.js';

let cached; // Bot переиспользуется между запросами одного изолята
function getBot(env) {
  if (!cached || cached.token !== env.TG_BOT_TOKEN) {
    const bot = createBot(env);
    cached = {
      token: env.TG_BOT_TOKEN,
      bot,
      handle: webhookCallback(bot, 'cloudflare-mod', { secretToken: env.TG_WEBHOOK_SECRET }),
    };
  }
  return cached;
}

const NAME_RE = /^[\p{L}\p{N} .'-]{1,40}$/u;

async function handleApi(request, env, url, ctx) {
  // Подпись Telegram — единственный способ войти: Authorization: tma <initData>
  const auth = request.headers.get('Authorization') ?? '';
  const tgUser = auth.startsWith('tma ')
    ? await validateInitData(auth.slice(4), env.TG_BOT_TOKEN)
    : null;
  if (!tgUser) return json({ error: 'unauthorized' }, 401);

  const D = env.DB;
  const isAdminId = tgUser.id === Number(env.ADMIN_TELEGRAM_ID);
  const user = await db.getUser(D, tgUser.id);
  if (user?.status === 'blocked') return json({ error: 'blocked' }, 403);
  const path = url.pathname;
  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

  // --- кто я ---
  if (path === '/api/me' && request.method === 'GET') {
    if (user) {
      return json({ state: 'user', user: pub(user) });
    }
    const code = url.searchParams.get('code') ?? '';
    const invite = isAdminId ? 'admin' : db.inviteState(code ? await db.getInvite(D, code) : null);
    return json({ state: 'new', invite });
  }

  // --- знакомство ---
  if (path === '/api/join' && request.method === 'POST') {
    if (user) return json({ state: 'user', user: pub(user) });
    const label = String(body.name ?? '').trim().replace(/\s+/g, ' ');
    if (!NAME_RE.test(label)) return json({ error: 'bad_name' }, 400);
    if (!isValidTz(body.tz)) return json({ error: 'bad_tz' }, 400);
    const res = await db.registerUser(D, {
      id: tgUser.id, tgName: tgUser.first_name ?? null, label, tz: body.tz,
      code: String(body.code ?? ''), isAdmin: isAdminId,
    });
    if (res.error) return json({ error: res.error }, 409);
    // Сообщаем админу; если он ещё не открывал бота, Telegram не даст написать, это нормально
    if (!isAdminId) {
      ctx.waitUntil(getBot(env).bot.api.sendMessage(Number(env.ADMIN_TELEGRAM_ID),
        `Новый человек в Блокноте: ${label} (в Telegram: ${tgUser.first_name ?? 'без имени'}, ${body.tz}).`).catch(() => {}));
    }
    return json({ state: 'user', user: pub(res.user) });
  }

  if (!user) return json({ error: 'not_registered' }, 403);

  // --- настройки ---
  if (path === '/api/settings' && request.method === 'POST') {
    const patch = {};
    if (body.tz !== undefined) {
      if (!isValidTz(body.tz)) return json({ error: 'bad_tz' }, 400);
      patch.tz = body.tz;
    }
    if (body.theme !== undefined) {
      if (!['auto', 'light', 'dark'].includes(body.theme)) return json({ error: 'bad_theme' }, 400);
      patch.theme = body.theme;
    }
    await db.updateSettings(D, user.id, patch);
    return json({ user: pub(await db.getUser(D, user.id)) });
  }

  // --- «Подключить бота»: после согласия в окне Telegram проверяем, что бот реально может написать ---
  if (path === '/api/connect-bot' && request.method === 'POST') {
    try {
      await getBot(env).bot.api.sendMessage(user.id,
        'Бот подключён. Пишите или наговаривайте сюда заметки, а приложение открывается кнопкой «Блокнот» внизу слева.');
    } catch {
      return json({ ok: false });
    }
    await db.markCanWrite(D, user.id);
    return json({ ok: true, user: pub(await db.getUser(D, user.id)) });
  }

  return json({ error: 'not_found' }, 404);
}

const pub = (u) => ({ label: u.label, tz: u.tz, theme: u.theme, can_write: !!u.can_write, is_admin: !!u.is_admin });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/tg/webhook' && request.method === 'POST') {
      return getBot(env).handle(request); // секрет проверяет grammY (401 при несовпадении)
    }

    if (path === '/cron/tick') { // этап 4
      if (request.headers.get('X-Cron-Secret') !== env.CRON_SECRET) return new Response('Forbidden', { status: 403 });
      return json({ sent: 0 });
    }

    if (path === '/diag') { // ВРЕМЕННО: удалить после отладки
      const t = env.TG_BOT_TOKEN ?? '';
      return json({ len: t.length, botId: t.split(':')[0], trimmedLen: t.trim().length, hasColon: t.includes(':'),
        webhookSecretLen: (env.TG_WEBHOOK_SECRET ?? '').length, adminId: env.ADMIN_TELEGRAM_ID });
    }

    if (path.startsWith('/api/')) return handleApi(request, env, url, ctx);

    return env.ASSETS.fetch(request); // приложение: index.html, app.js, style.css
  },
};
