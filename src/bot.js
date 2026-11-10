import { Bot } from 'grammy';
import * as db from './db.js';
import { escapeHtml } from './util.js';

const REFUSAL = 'Бот работает по приглашению. Попросите у владельца ссылку-приглашение.';

const ERR_TEXT = {
  unknown: 'Ссылка недействительна. Попросите новое приглашение.',
  revoked: 'Это приглашение отозвано. Попросите новое.',
  used: 'Это приглашение уже использовано.',
  label_taken: 'Пользователь с такой меткой уже есть. Обратитесь к владельцу.',
};

export function createBot(env) {
  const bot = new Bot(env.TG_BOT_TOKEN, {
    // TG_API_ROOT нужен только для локальных проверок с заглушкой Telegram
    client: env.TG_API_ROOT ? { apiRoot: env.TG_API_ROOT } : undefined,
  });
  const D = env.DB;
  const adminId = Number(env.ADMIN_TELEGRAM_ID);

  // Единая проверка допуска. Заблокированным отвечаем, но ничего не выполняем.
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (!from || ctx.chat?.type !== 'private') return;

    let user = await db.getUser(D, from.id);
    if (!user && from.id === adminId) {
      user = await db.createAdmin(D, from.id, from.first_name ?? null);
    }
    ctx.user = user;

    const text = ctx.message?.text ?? '';
    const isStartWithToken = /^\/start(@\w+)?\s+\S+/.test(text);
    if (!user && !isStartWithToken) return ctx.reply(REFUSAL);
    if (user?.status === 'blocked') return ctx.reply('Доступ закрыт.');
    return next();
  });

  bot.command('start', async (ctx) => {
    const token = (ctx.match || '').trim();
    if (ctx.user) {
      return ctx.reply(`Привет, ${ctx.user.label}! Пишите или наговаривайте заметки, я их запишу. /help — справка.`);
    }
    if (!token) return ctx.reply(REFUSAL);

    const res = await db.redeemClaim(D, token, ctx.from.id, ctx.from.first_name ?? null);
    if (res.error) return ctx.reply(ERR_TEXT[res.error]);
    await ctx.reply(
      `Готово, ${res.user.label}! Часовой пояс: ${res.user.tz}. Создал папки: Идеи, Задачи, Покупки, Разное.\n` +
      'Скоро здесь можно будет писать и наговаривать заметки.');
    // Сообщаем админу, что приглашение использовано
    await bot.api.sendMessage(adminId,
      `${res.user.label} подключился (${res.user.name ?? 'без имени'}, ${res.user.tz}).`).catch(() => {});
  });

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

  bot.command('invite', admin(async (ctx, label) => {
    if (!label) return ctx.reply('Для кого? Например: /invite Олег');
    if (label.length > 40) return ctx.reply('Имя слишком длинное.');
    if (await db.findUserByLabel(D, label)) return ctx.reply(`Человек «${label}» уже есть. Выберите другую метку, например «${label} Иванов».`);
    const code = await db.createInvite(D, label, ctx.user.id);
    await db.audit(D, ctx.user.id, 'invite', label);
    return ctx.reply(
      `Приглашение для «${label}». Одноразовая ссылка:\n${env.PUBLIC_URL ?? 'https://notes.fixtorllc.com'}/join/${code}`,
      { link_preview_options: { is_disabled: true } });
  }));

  bot.command('revoke', admin(async (ctx, label) => {
    if (!label) return ctx.reply('Чьё приглашение отозвать? Например: /revoke Олег');
    const n = await db.revokeInvitesByLabel(D, label);
    if (n) await db.audit(D, ctx.user.id, 'revoke', label);
    return ctx.reply(n ? `Отозвано приглашений: ${n}.` : 'Неиспользованных приглашений с такой меткой нет.');
  }));

  bot.command('users', admin(async (ctx) => {
    const users = await db.listUsers(D);
    const open = await db.listOpenInvites(D);
    const lines = users.map((u) =>
      `${u.status === 'blocked' ? '⛔' : '✅'} ${escapeHtml(u.label)}${u.is_admin ? ' (админ)' : ''} — ` +
      `${escapeHtml(u.name ?? 'без имени')}, ${u.tz}`);
    if (open.length) {
      lines.push('', 'Ждут подключения:', ...open.map((i) =>
        `⏳ ${escapeHtml(i.label)}${i.claimed_at ? ' (открыл ссылку)' : ''}`));
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
    return ctx.reply(`«${u.label}» отключён. Его сессии закрыты.`);
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
