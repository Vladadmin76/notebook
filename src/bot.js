import { Bot } from 'grammy';
import * as db from './db.js';
import { escapeHtml } from './util.js';
import { processNote, onlyLinks } from './deepseek.js';
import { LIMITS, INBOX_NAME } from './config.js';
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
    const base = 'Просто напишите или наговорите заметки (хоть сразу несколько дел): я исправлю текст, разделю на отдельные заметки и разложу по папкам. Покупки собираю в общий список. Если пришлёте только ссылку, сохраню её во «Входящие». Если назовёте время («завтра в 9», «через 2 часа», «каждый понедельник»), поставлю напоминание.\n\nКоманды:\n/folders — папки и число заметок\n/list — последние заметки\n/buy — списки покупок с галочками (/buy Costco покажет один магазин)\n/cancel — отменить ожидание комментария\n/reminders — будущие напоминания\n/help — справка';
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

  // ---------- списки покупок по магазинам ----------
  // key: 'all' (все), 'none' («Без магазина») или номер списка
  const SHOP_LIMIT = 50; // столько пунктов показываем кнопками
  const keyLabel = (key, lists) => (key === 'all' ? 'Все' : key === 'none' ? 'Без магазина' : (lists.find((l) => l.id === Number(key))?.name ?? 'Список'));

  async function shoppingView(userId, key = 'all') {
    const { lists, none } = await db.listShoppingLists(D, userId);
    const k = key === 'all' || key === 'none' ? key : Number(key);
    const items = await db.listShopping(D, userId, k);

    // Переключатель списков: выбранный отмечен точкой
    const chip = (kk, label, open) => ({ text: `${String(kk) === String(key) ? '● ' : ''}${label}${open ? ` ${open}` : ''}`, callback_data: `sv:${kk}` });
    const total = none.open + lists.reduce((a, l) => a + l.open, 0);
    const chips = [chip('all', 'Все', total), ...lists.map((l) => chip(l.id, l.name, l.open)), chip('none', 'Без магазина', none.open)];
    const rows = [];
    for (let i = 0; i < chips.length; i += 2) rows.push(chips.slice(i, i + 2));

    const shown = items.slice(0, SHOP_LIMIT);
    let lastList;
    for (const i of shown) {
      if (key === 'all' && i.list_name !== lastList) { rows.push([{ text: `— ${i.list_name ?? 'Без магазина'} —`, callback_data: 'noop' }]); lastList = i.list_name; }
      rows.push([{ text: `${i.done ? '✅' : '⬜'} ${i.name}`, callback_data: `si:${i.id}:${key}` }]);
    }
    const doneCount = items.filter((i) => i.done).length;
    if (doneCount) rows.push([{ text: `Очистить купленное (${doneCount})`, callback_data: `sc:${key}` }]);
    const more = items.length > shown.length ? ` Показаны первые ${SHOP_LIMIT} из ${items.length}.` : '';
    const title = `🛒 Список покупок · ${keyLabel(key, lists)}`;
    return { text: items.length ? `${title}\nНажмите на пункт, чтобы отметить купленное.${more}` : `${title}\nПока пусто.`, markup: { inline_keyboard: rows } };
  }

  // /buy, /buy Costco, /buy все
  async function showShopping(ctx, name) {
    const q = (name ?? '').trim();
    let key = 'all';
    let note = '';
    if (q && !/^(все|всё|all)$/i.test(q)) {
      if (/^без магазина$/i.test(q)) key = 'none';
      else {
        const l = await db.findShoppingList(D, ctx.user.id, q);
        if (l) key = l.id; else note = `Списка «${q}» нет. Показываю все покупки.\n`;
      }
    }
    const v = await shoppingView(ctx.user.id, key);
    return ctx.reply(note + v.text, { reply_markup: v.markup });
  }

  bot.command('buy', (ctx) => showShopping(ctx, ctx.match));

  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery());
  bot.callbackQuery('sl', async (ctx) => { await ctx.answerCallbackQuery(); return showShopping(ctx, ''); });

  // Переключение между списками, отметка «куплено», очистка. Кнопки из старых сообщений (без ключа) работают как «все».
  const redraw = async (ctx, key) => {
    const v = await shoppingView(ctx.user.id, key);
    return ctx.editMessageText(v.text, { reply_markup: v.markup }).catch(() => {});
  };
  bot.callbackQuery(/^sv:(all|none|\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); return redraw(ctx, ctx.match[1]); });
  bot.callbackQuery(/^si:(\d+)(?::(all|none|\d+))?$/, async (ctx) => {
    await db.toggleShopping(D, ctx.user.id, Number(ctx.match[1]));
    await ctx.answerCallbackQuery();
    return redraw(ctx, ctx.match[2] ?? 'all');
  });
  bot.callbackQuery(/^sc(?::(all|none|\d+))?$/, async (ctx) => {
    const key = ctx.match[1] ?? 'all';
    const n = await db.clearDoneShopping(D, ctx.user.id, key === 'all' || key === 'none' ? key : Number(key));
    await ctx.answerCallbackQuery({ text: n ? `Убрано: ${n}` : 'Нечего убирать' });
    return redraw(ctx, key);
  });

  // ---------- разбор сообщения на заметки ----------
  // Одна заметка: сохраняем, ставим напоминание, отвечаем отдельным сообщением с кнопками
  async function createNote(ctx, { note, rawText, source, nowIso, failedNote = false }) {
    const folderName = note.folder ?? FALLBACK_FOLDER;
    const folder = await db.getOrCreateFolder(D, ctx.user.id, folderName);
    const noteId = await db.insertNote(D, { userId: ctx.user.id, folderId: folder.id, text: note.text, rawText, source });

    // Напоминание, если модель его нашла и дата получилась разумной
    const plan = planReminder(note.remind, ctx.user.tz, nowIso);
    let reminderLine = '';
    if (plan) {
      await db.insertReminder(D, { userId: ctx.user.id, noteId, remindAt: plan.remindAt, rrule: plan.rrule, anchorDate: plan.anchorDate,
        localTime: plan.localTime, tz: plan.tz, text: note.remind.text });
      const what = note.remind.text ?? note.text;
      reminderLine = plan.rrule
        ? `\n⏰ Буду напоминать ${describeRepeat(plan.rrule, plan.localTime)}, первый раз ${formatWhen(plan.remindAt, plan.tz, nowIso)}: ${escapeHtml(what)}`
        : `\n⏰ Напомню ${formatWhen(plan.remindAt, plan.tz, nowIso)}: ${escapeHtml(what)}`;
    }
    const created = note.isNewFolder ? ' (новая папка)' : '';
    const msg = failedNote
      ? `Записал в папку «${escapeHtml(FALLBACK_FOLDER)}» как есть: не удалось обработать текст, попробуйте позже.\n<i>${escapeHtml(note.text)}</i>`
      : `Записал в папку «${escapeHtml(folderName)}»${created}:\n<i>${escapeHtml(note.text)}</i>${reminderLine}`;
    return ctx.reply(msg, { parse_mode: 'HTML', reply_markup: noteKeyboard(noteId, !!plan) });
  }

  // ---------- ссылки: «Входящие» ----------
  async function saveLinks(ctx, links) {
    const inbox = await db.getOrCreateFolder(D, ctx.user.id, INBOX_NAME);
    for (const url of links) {
      if (await db.findNoteByText(D, ctx.user.id, inbox.id, url)) { await ctx.reply(`Эта ссылка уже во «${INBOX_NAME}»:\n${url}`, { link_preview_options: { is_disabled: true } }); continue; }
      const noteId = await db.insertNote(D, { userId: ctx.user.id, folderId: inbox.id, text: url, rawText: url });
      await ctx.reply(`📥 Сохранил во «${INBOX_NAME}»:\n${url}\nКуда поместить ссылку? Можно выбрать папку или оставить здесь: раз в сутки в 12:00 я напомню разобрать.`, {
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [
          [{ text: 'Куда поместить', callback_data: `mvp:${noteId}` }, { text: 'Добавить комментарий', callback_data: `cm:${noteId}` }],
          [{ text: 'Удалить', callback_data: `del:${noteId}` }],
        ] },
      });
    }
  }

  bot.callbackQuery(/^cm:(\d+)$/, async (ctx) => {
    const noteId = Number(ctx.match[1]);
    if (!(await db.getNote(D, ctx.user.id, noteId))) return ctx.answerCallbackQuery({ text: 'Ссылка не найдена' });
    await db.setState(D, ctx.user.id, 'comment', noteId, new Date(Date.now() + 10 * 60e3).toISOString());
    await ctx.answerCallbackQuery();
    return ctx.reply('Напишите комментарий к этой ссылке одним сообщением (или /cancel, чтобы отменить).');
  });

  bot.command('cancel', async (ctx) => {
    await db.clearState(D, ctx.user.id);
    return ctx.reply('Отменил.');
  });

  // Общая обработка текста (набранного или распознанного из голоса)
  async function saveNote(ctx, text, source) {
    if (text.length > LIMITS.TEXT_MAX_CHARS) {
      return ctx.reply(`Заметка слишком длинная: ${text.length} знаков, максимум ${LIMITS.TEXT_MAX_CHARS}. Разбейте её на части.`);
    }
    await ctx.replyWithChatAction('typing').catch(() => {});

    const folders = (await db.listFolders(D, ctx.user.id)).filter((f) => f.kind !== 'inbox').map((f) => f.name);
    const nowIso = new Date().toISOString();
    const when = { ...localNowInfo(ctx.user.tz, nowIso), tz: ctx.user.tz };
    const result = await processNote(env, text, folders, when);

    // Не получилось разобрать: сохраняем всё как есть одной заметкой
    if (!result) return createNote(ctx, { note: { text, folder: null, remind: null }, rawText: text, source, nowIso, failedNote: true });

    const { notes, shopping, request } = result;

    // Просьба «покажи список для Costco» / «покажи все продукты»: отвечаем списком, заметку не создаём
    if (request && !notes.length && !shopping.length) return showShopping(ctx, request.all ? '' : request.store);

    // Покупки: магазин из фразы определяет список (новый магазин создаётся сам), без магазина идёт в «Без магазина»
    let addedItems = [], existingItems = [];
    if (shopping.length) {
      const ids = new Map();
      const withLists = [];
      for (const it of shopping) {
        let listId = null;
        if (it.store) {
          const k = it.store.toLowerCase();
          if (!ids.has(k)) ids.set(k, await db.getOrCreateShoppingList(D, ctx.user.id, it.store));
          listId = ids.get(k).id;
        }
        withLists.push({ name: it.name, listId, store: it.store ? ids.get(it.store.toLowerCase()).name : null });
      }
      const res = await db.addShoppingItems(D, ctx.user.id, withLists);
      addedItems = res.added; existingItems = res.existing;
    }

    const parts = notes.length + (shopping.length ? 1 : 0);
    if (parts > 1) await ctx.reply(`Разобрал на ${parts} ${parts < 5 ? 'заметки' : 'заметок'}:`);

    for (const note of notes) await createNote(ctx, { note, rawText: text, source, nowIso });

    if (shopping.length) {
      const group = (arr) => {
        const m = new Map();
        for (const i of arr) { const k = i.store ?? 'Без магазина'; m.set(k, [...(m.get(k) ?? []), i.name]); }
        return [...m.entries()].map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ');
      };
      const lines = [];
      if (addedItems.length) lines.push(`🛒 Добавил в список покупок. ${escapeHtml(group(addedItems))}`);
      if (existingItems.length) lines.push(`Уже в списке: ${escapeHtml(existingItems.map((i) => i.name).join(', '))}`);
      await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'Открыть список', callback_data: 'sl' }]] } });
    }
  }

  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return next(); // команды обрабатываются ниже, неизвестная команда не становится заметкой
    if (!text) return;

    // Одни ссылки: сохраняем во «Входящие» и предлагаем разложить
    const links = onlyLinks(text);
    if (links) return saveLinks(ctx, links.slice(0, 10));

    // Ждём комментарий к ссылке (после кнопки «Добавить комментарий»)
    const st = await db.getState(D, ctx.user.id);
    if (st && st.kind === 'comment') {
      await db.clearState(D, ctx.user.id);
      const ok = text.length <= 500 && (await db.appendToNote(D, ctx.user.id, st.note_id, text, LIMITS.TEXT_MAX_CHARS));
      return ctx.reply(ok ? 'Добавил комментарий к ссылке.' : 'Не получилось добавить комментарий: он слишком длинный или заметки уже нет.',
        ok ? { reply_markup: await noteKeyboardFor(ctx.user.id, st.note_id) } : undefined);
    }
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
