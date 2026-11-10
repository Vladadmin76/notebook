import { Bot } from 'grammy';
import * as db from './db.js';
import { escapeHtml } from './util.js';
import { processNote } from './deepseek.js';
import { LIMITS } from './config.js';
import { transcribe } from './groq.js';
import { downloadFile, TG_DOWNLOAD_LIMIT } from './telegram.js';
import { localNowInfo, planReminder, formatWhen, describeRepeat, snoozeHour, tomorrowNine } from './timeutil.js';

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
    const base = 'Просто напишите или наговорите заметку: я исправлю текст и разложу по папкам. Если назовёте время («завтра в 9», «через 2 часа», «каждый понедельник»), поставлю напоминание.\n\nКоманды:\n/folders — папки и число заметок\n/list — последние заметки\n/reminders — будущие напоминания\n/help — справка';
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

  // ---------- заметки ----------
  const FALLBACK_FOLDER = 'Разное';
  const noteKeyboard = (noteId, hasReminder = false) => ({ inline_keyboard: [
    [{ text: 'Сменить папку', callback_data: `mvp:${noteId}` }, { text: 'Удалить', callback_data: `del:${noteId}` }],
    ...(hasReminder ? [[{ text: 'Убрать напоминание', callback_data: `rr:${noteId}` }]] : []),
  ] });
  const noteKeyboardFor = async (userId, noteId) => noteKeyboard(noteId, await db.hasPendingReminder(D, userId, noteId));

  bot.command('folders', async (ctx) => {
    const folders = await db.listFolders(D, ctx.user.id);
    return ctx.reply(folders.map((f) => `📁 ${f.name}: ${f.n}`).join('\n') || 'Папок пока нет.');
  });

  bot.command('list', async (ctx) => {
    const notes = await db.listNotes(D, ctx.user.id, 10);
    if (!notes.length) return ctx.reply('Заметок пока нет. Напишите что-нибудь, и я запишу.');
    const line = (n) => `• ${n.text.length > 80 ? n.text.slice(0, 80) + '…' : n.text} (${n.folder ?? 'без папки'})`;
    return ctx.reply(notes.map(line).join('\n'));
  });

  // Общая обработка текста заметки (набранного или распознанного из голоса)
  async function saveNote(ctx, text, source) {
    if (text.length > LIMITS.TEXT_MAX_CHARS) {
      return ctx.reply(`Заметка слишком длинная: ${text.length} знаков, максимум ${LIMITS.TEXT_MAX_CHARS}. Разбейте её на части.`);
    }
    await ctx.replyWithChatAction('typing').catch(() => {});

    const folders = (await db.listFolders(D, ctx.user.id)).map((f) => f.name);
    const nowIso = new Date().toISOString();
    const when = { ...localNowInfo(ctx.user.tz, nowIso), tz: ctx.user.tz };
    const result = await processNote(env, text, folders, when);

    let finalText = text;
    let folderName = FALLBACK_FOLDER;
    let failed = true;
    if (result) {
      failed = false;
      finalText = result.text;
      folderName = result.folder ?? FALLBACK_FOLDER;
    }
    const folder = await db.getOrCreateFolder(D, ctx.user.id, folderName);
    const noteId = await db.insertNote(D, { userId: ctx.user.id, folderId: folder.id, text: finalText, rawText: text, source });

    // Напоминание, если модель его нашла и дата получилась разумной
    const plan = result ? planReminder(result.remind, ctx.user.tz, nowIso) : null;
    let reminderLine = '';
    if (plan) {
      await db.insertReminder(D, { userId: ctx.user.id, noteId, remindAt: plan.remindAt, rrule: plan.rrule, anchorDate: plan.anchorDate,
        localTime: plan.localTime, tz: plan.tz, text: result.remind.text });
      const what = result.remind.text ?? finalText;
      reminderLine = plan.rrule
        ? `\n⏰ Буду напоминать ${describeRepeat(plan.rrule, plan.localTime)}, первый раз ${formatWhen(plan.remindAt, plan.tz, nowIso)}: ${escapeHtml(what)}`
        : `\n⏰ Напомню ${formatWhen(plan.remindAt, plan.tz, nowIso)}: ${escapeHtml(what)}`;
    }

    const created = result?.isNewFolder ? ' (новая папка)' : '';
    const msg = failed
      ? `Записал в папку «${escapeHtml(FALLBACK_FOLDER)}» как есть: не удалось обработать текст, попробуйте позже.\n<i>${escapeHtml(finalText)}</i>`
      : `Записал в папку «${escapeHtml(folderName)}»${created}:\n<i>${escapeHtml(finalText)}</i>${reminderLine}`;
    return ctx.reply(msg, { parse_mode: 'HTML', reply_markup: noteKeyboard(noteId, !!plan) });
  }

  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return next(); // команды обрабатываются ниже, неизвестная команда не становится заметкой
    if (!text) return;
    return saveNote(ctx, text, 'text');
  });

  // Голосовые и аудио: скачиваем, распознаём в Groq, дальше как обычная заметка
  async function handleVoice(ctx, media, defaultName, defaultMime) {
    if ((media.duration ?? 0) > LIMITS.VOICE_MAX_SECONDS) {
      return ctx.reply(`Голосовое слишком длинное: ${media.duration} с, максимум ${LIMITS.VOICE_MAX_SECONDS} с. Запишите покороче.`);
    }
    if ((media.file_size ?? 0) > TG_DOWNLOAD_LIMIT) {
      return ctx.reply('Файл слишком большой, Telegram не отдаёт такие боту. Запишите покороче.');
    }
    await ctx.replyWithChatAction('typing').catch(() => {});
    const file = await downloadFile(env, ctx.api, media.file_id).catch(() => null);
    if (!file) return ctx.reply('Не удалось получить голосовое. Попробуйте ещё раз.');

    const text = await transcribe(env, file.bytes, defaultName, media.mime_type ?? defaultMime);
    if (text === null) return ctx.reply('Не удалось распознать голос. Попробуйте ещё раз или напишите текстом.');
    if (!text) return ctx.reply('Не разобрал речь в этом сообщении. Попробуйте ещё раз.');
    return saveNote(ctx, text, 'voice');
  }

  bot.on('message:voice', (ctx) => handleVoice(ctx, ctx.message.voice, 'voice.ogg', 'audio/ogg'));
  bot.on('message:audio', (ctx) => handleVoice(ctx, ctx.message.audio, ctx.message.audio.file_name ?? 'audio.mp3', 'audio/mpeg'));

  // «Сменить папку»: показываем папки пользователя
  bot.callbackQuery(/^mvp:(\d+)$/, async (ctx) => {
    const noteId = Number(ctx.match[1]);
    const note = await db.getNote(D, ctx.user.id, noteId);
    if (!note) return ctx.answerCallbackQuery({ text: 'Заметка не найдена' });
    const folders = await db.listFolders(D, ctx.user.id);
    const rows = folders.map((f) => [{ text: `${f.id === note.folder_id ? '✓ ' : ''}${f.name}`, callback_data: `mv:${noteId}:${f.id}` }]);
    rows.push([{ text: 'Отмена', callback_data: `mvc:${noteId}` }]);
    await ctx.answerCallbackQuery();
    return ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: rows } });
  });

  bot.callbackQuery(/^mvc:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    return ctx.editMessageReplyMarkup({ reply_markup: await noteKeyboardFor(ctx.user.id, Number(ctx.match[1])) });
  });

  bot.callbackQuery(/^mv:(\d+):(\d+)$/, async (ctx) => {
    const [noteId, folderId] = [Number(ctx.match[1]), Number(ctx.match[2])];
    const ok = await db.moveNote(D, ctx.user.id, noteId, folderId);
    if (!ok) return ctx.answerCallbackQuery({ text: 'Не получилось' });
    const note = await db.getNote(D, ctx.user.id, noteId);
    await ctx.answerCallbackQuery({ text: `Перенёс в «${note.folder}»` });
    return ctx.editMessageText(`Записал в папку «${escapeHtml(note.folder)}»:\n<i>${escapeHtml(note.text)}</i>`,
      { parse_mode: 'HTML', reply_markup: await noteKeyboardFor(ctx.user.id, noteId) });
  });

  bot.callbackQuery(/^del:(\d+)$/, async (ctx) => {
    const ok = await db.deleteNote(D, ctx.user.id, Number(ctx.match[1]));
    await ctx.answerCallbackQuery({ text: ok ? 'Удалено' : 'Уже удалено' });
    return ctx.editMessageText('Заметка удалена.');
  });

  // ---------- напоминания ----------
  bot.command('reminders', async (ctx) => {
    const list = await db.listPendingReminders(D, ctx.user.id, 20);
    if (!list.length) return ctx.reply('Будущих напоминаний нет. Напишите, например: «завтра в 9 позвонить Ивану».');
    const nowIso = new Date().toISOString();
    const line = (r) => `• ${formatWhen(r.remind_at, ctx.user.tz, nowIso)}${r.rrule ? ` (повтор: ${describeRepeat(r.rrule, r.local_time)})` : ''} — ${r.msg ?? ''}`;
    return ctx.reply(list.map(line).join('\n'));
  });

  // «Готово» под сработавшим напоминанием
  bot.callbackQuery(/^rd:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Готово' });
    const original = ctx.callbackQuery.message?.text ?? '';
    return ctx.editMessageText(`✅ ${original.replace(/^🔔\s*/, '')}`);
  });

  // «Отложить»: создаём отдельное разовое напоминание, повторяющаяся серия не страдает
  bot.callbackQuery(/^rs:(\d+):([ht])$/, async (ctx) => {
    const r = await db.getReminder(D, ctx.user.id, Number(ctx.match[1]));
    if (!r) return ctx.answerCallbackQuery({ text: 'Напоминание не найдено' });
    const nowIso = new Date().toISOString();
    const at = ctx.match[2] === 'h' ? snoozeHour(nowIso) : tomorrowNine(ctx.user.tz, nowIso);
    await db.insertReminder(D, { userId: ctx.user.id, noteId: r.note_id, remindAt: at, tz: ctx.user.tz, text: r.text });
    await ctx.answerCallbackQuery({ text: 'Отложено' });
    return ctx.editMessageText(`⏰ Отложено до ${formatWhen(at, ctx.user.tz, nowIso)}: ${r.msg ?? ''}`);
  });

  // «Убрать напоминание» под сообщением о заметке
  bot.callbackQuery(/^rr:(\d+)$/, async (ctx) => {
    const noteId = Number(ctx.match[1]);
    await db.cancelNoteReminders(D, ctx.user.id, noteId);
    await ctx.answerCallbackQuery({ text: 'Напоминание убрано' });
    return ctx.editMessageReplyMarkup({ reply_markup: noteKeyboard(noteId, false) });
  });

  bot.catch((err) => console.error('bot error', err.error ?? err));
  return bot;
}
