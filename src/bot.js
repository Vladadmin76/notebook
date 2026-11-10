import { Bot } from 'grammy';
import * as db from './db.js';
import { escapeHtml } from './util.js';

const REFUSAL = 'Бот работает по приглашению. Попросите у владельца ссылку-приглашение и откройте её в Telegram.';

export function createBot(env) {
  const bot = new Bot(env.TG_BOT_TOKEN, {
    // TG_API_ROOT нужен только для локальных проверок с заглушкой Telegram
    client: env.TG_API_ROOT ? { apiRoot: env.TG_API_ROOT } : undefined,
  });
  const D = env.DB;
  const adminId = Number(env.ADMIN_TELEGRAM_ID);

  const appUrl = env.PUBLIC_URL ?? 'https://notes.fixtorllc.com';
  const openApp = { reply_markup: { inline_keyboard: [[{ text: 'Открыть Блокнот', web_app: { url: appUrl } }]] } };

  // Единая проверка допуска. Регистрируются люди только в приложении, не в боте.
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (!from || ctx.chat?.type !== 'private') return;

    const user = await db.getUser(D, from.id);
    ctx.user = user;
    if (!user) {
      if (from.id === adminId) return ctx.reply('Сначала откройте приложение и познакомьтесь с ботом.', openApp);
      return ctx.reply(REFUSAL);
    }
    if (user.status === 'blocked') return ctx.reply('Доступ закрыт.');
    return next();
  });

  bot.command('start', (ctx) =>
    ctx.reply(`Привет, ${ctx.user.label}! Пишите или наговаривайте заметки, я их запишу. /help — справка.`, openApp));

  bot.command('help', (ctx) => {
    const base = 'Команды:\n/help — справка';
    const admin = '\n\nАдмин:\n/invite Имя — ссылка-приглашение\n/revoke Имя — отозвать приглашение\n' +
      '/users — список людей\n/block Имя\n/unblock Имя\n/remove Имя — удалить человека вместе с данными';
    return ctx.reply(base + (ctx.user.is_admin ? admin : ''));
  });

  // ---------- команды админа ----------
  const admin = (handler) => async (ctx) => {
    if (!ctx.user?.is_admin) return; // молча игнорируем
    return handler(ctx, (ctx.match || '').trim());
  };

  bot.command('invite', admin(async (ctx, note) => {
    if (note.length > 40) return ctx.reply('Подпись слишком длинная.');
    const code = await db.createInvite(D, note, ctx.user.id);
    await db.audit(D, ctx.user.id, 'invite', note || null);
    return ctx.reply(
      `Приглашение${note ? ` для «${note}»` : ''}. Одноразовая ссылка, откроется в Telegram:\n` +
      `https://t.me/${env.BOT_USERNAME}?startapp=${code}`,
      { link_preview_options: { is_disabled: true } });
  }));

  bot.command('revoke', admin(async (ctx, note) => {
    if (!note) return ctx.reply('Чьё приглашение отозвать? Например: /revoke Олег');
    const n = await db.revokeInvitesByNote(D, note);
    if (n) await db.audit(D, ctx.user.id, 'revoke', note);
    return ctx.reply(n ? `Отозвано приглашений: ${n}.` : 'Неиспользованных приглашений с такой подписью нет.');
  }));

  bot.command('users', admin(async (ctx) => {
    const users = await db.listUsers(D);
    const open = await db.listOpenInvites(D);
    const lines = users.map((u) =>
      `${u.status === 'blocked' ? '⛔' : '✅'} ${escapeHtml(u.label)}${u.is_admin ? ' (админ)' : ''} — ` +
      `${escapeHtml(u.name ?? 'без имени')}, ${u.tz}${u.can_write ? '' : ', бот не подключён'}`);
    if (open.length) {
      lines.push('', 'Приглашения, которые ещё не открыли:', ...open.map((i) => `⏳ ${escapeHtml(i.note || 'без подписи')}`));
    }
    return ctx.reply(lines.join('\n') || 'Пока никого.', { parse_mode: 'HTML' });
  }));

  async function withTarget(ctx, label, fn) {
    if (!label) return ctx.reply('Укажите имя, например: /block Олег');
    const u = await db.findUserByLabel(D, label);
    if (!u) return ctx.reply(`Не нашёл «${label}». Список: /users`);
    if (u.is_admin) return ctx.reply('Админа нельзя трогать.');
    return fn(u);
  }

  bot.command('block', admin((ctx, label) => withTarget(ctx, label, async (u) => {
    await db.setStatus(D, u.id, 'blocked');
    await db.audit(D, ctx.user.id, 'block', u.label);
    return ctx.reply(`«${u.label}» отключён: бот и приложение ему больше не отвечают.`);
  })));

  bot.command('unblock', admin((ctx, label) => withTarget(ctx, label, async (u) => {
    await db.setStatus(D, u.id, 'active');
    await db.audit(D, ctx.user.id, 'unblock', u.label);
    return ctx.reply(`«${u.label}» снова с доступом.`);
  })));

  bot.command('remove', admin((ctx, label) => withTarget(ctx, label, async (u) =>
    ctx.reply(`Удалить «${u.label}» вместе со всеми заметками? Это нельзя отменить.`, {
      reply_markup: { inline_keyboard: [[
        { text: 'Да, удалить', callback_data: `rm:${u.id}` },
        { text: 'Отмена', callback_data: 'rm:cancel' },
      ]] },
    }))));

  bot.callbackQuery(/^rm:(.+)$/, async (ctx) => {
    if (!ctx.user?.is_admin) return ctx.answerCallbackQuery();
    const arg = ctx.match[1];
    if (arg === 'cancel') {
      await ctx.answerCallbackQuery('Отменено');
      return ctx.editMessageText('Удаление отменено.');
    }
    const u = await db.getUser(D, Number(arg));
    if (!u || u.is_admin) return ctx.answerCallbackQuery('Не найден');
    await db.removeUser(D, u.id);
    await db.audit(D, ctx.user.id, 'remove', u.label);
    await ctx.answerCallbackQuery('Удалено');
    return ctx.editMessageText(`«${u.label}» удалён вместе с данными.`);
  });

  bot.on('message', (ctx) => ctx.reply('Сохранение заметок появится на следующем этапе.'));
  bot.catch((err) => console.error('bot error', err.error ?? err));
  return bot;
}
