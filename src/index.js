import { createBot } from './bot.js';
import * as db from './db.js';
import { validateInitData } from './auth.js';
import { json, isValidTz } from './util.js';
import { processTick } from './reminders.js';
import { handleAppApi, serveIcs } from './appapi.js';
import { verifyIcs } from './ics.js';

let cached; // Bot переиспользуется между запросами одного изолята
function getBot(env) {
  if (!cached || cached.token !== env.TG_BOT_TOKEN) cached = { token: env.TG_BOT_TOKEN, bot: createBot(env) };
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

  // --- приложение: папки, заметки, календарь, напоминания, покупки ---
  {
    const res = await handleAppApi({ request, env, url, user, body });
    if (res) return res;
  }

  // --- панель управления: только админ, проверка на сервере ---
  if (path.startsWith('/api/admin/')) {
    if (!user.is_admin) return json({ error: 'forbidden' }, 403);
    const link = (code) => `https://t.me/${env.BOT_USERNAME}?startapp=${code}`;

    if (path === '/api/admin/overview' && request.method === 'GET') {
      const [users, invites] = await Promise.all([db.listUsers(D), db.listOpenInvites(D)]);
      return json({
        users: users.map((u) => ({ id: u.id, label: u.label, name: u.name, tz: u.tz, is_admin: !!u.is_admin,
          blocked: u.status === 'blocked', can_write: !!u.can_write })),
        invites: invites.map((i) => ({ code: i.code, note: i.note, link: link(i.code) })),
      });
    }
    if (path === '/api/admin/invite' && request.method === 'POST') {
      const note = String(body.note ?? '').trim().slice(0, 40);
      const code = await db.createInvite(D, note, user.id);
      await db.audit(D, user.id, 'invite', note || null);
      return json({ code, note, link: link(code) });
    }
    if (path === '/api/admin/revoke' && request.method === 'POST') {
      const n = await db.revokeInviteByCode(D, String(body.code ?? ''));
      if (n) await db.audit(D, user.id, 'revoke', String(body.code).slice(0, 6));
      return json({ ok: n > 0 });
    }
    if (['/api/admin/block', '/api/admin/unblock', '/api/admin/remove'].includes(path) && request.method === 'POST') {
      const target = await db.getUser(D, Number(body.id));
      if (!target) return json({ error: 'not_found' }, 404);
      if (target.is_admin) return json({ error: 'cannot_touch_admin' }, 400);
      const action = path.split('/').pop();
      if (action === 'remove') await db.removeUser(D, target.id);
      else await db.setStatus(D, target.id, action === 'block' ? 'blocked' : 'active');
      await db.audit(D, user.id, action, target.label);
      return json({ ok: true });
    }
    return json({ error: 'not_found' }, 404);
  }

  return json({ error: 'not_found' }, 404);
}

const pub = (u) => ({ label: u.label, tz: u.tz, theme: u.theme, can_write: !!u.can_write, is_admin: !!u.is_admin });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/tg/webhook' && request.method === 'POST') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_WEBHOOK_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      const update = await request.json().catch(() => null);
      if (!update) return new Response('Bad Request', { status: 400 });
      // Отвечаем Telegram сразу (иначе он повторит сообщение), а заметку обрабатываем в фоне
      const { bot } = getBot(env);
      ctx.waitUntil((async () => {
        if (!bot.isInited()) await bot.init();
        await bot.handleUpdate(update);
      })().catch((e) => console.error('update error', e)));
      return new Response('ok');
    }

    if (path === '/cron/tick') { // вызывается внешним таймером (cron-job.org) раз в минуту
      if (!env.CRON_SECRET || request.headers.get('X-Cron-Secret') !== env.CRON_SECRET) return new Response('Forbidden', { status: 403 });
      const { bot } = getBot(env);
      const sent = await processTick(env, bot.api);
      return json({ sent });
    }

    if (path === '/ics' && request.method === 'GET') return serveIcs(env, url, verifyIcs); // ссылка с подписью, без входа через Telegram

    if (path.startsWith('/api/')) return handleApi(request, env, url, ctx);

    return env.ASSETS.fetch(request); // приложение: index.html, app.js, style.css
  },
};
