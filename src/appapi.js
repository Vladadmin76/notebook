// Интерфейс приложения: папки, заметки, календарь, напоминания, список покупок.
// Все запросы выполняются от имени человека, подписанного Telegram (user), и видят только его данные.
import { DateTime } from 'luxon';
import * as db from './db.js';
import { json } from './util.js';
import { LIMITS } from './config.js';
import { utc, isoUtc, planReminder, nextRecurrence, parseRrule, describeRepeat, formatWhen } from './timeutil.js';
import { buildIcs, googleCalendarUrl, signIcs } from './ics.js';
import * as trash from './trash.js';

const FALLBACK_FOLDER = 'Разное';
const FOLDER_NAME_RE = /^[\p{L}\p{N} .,'&-]{1,30}$/u;
const intOr = (v) => (Number.isInteger(Number(v)) ? Number(v) : NaN);

// Представление напоминания для приложения
function reminderView(r, tz, nowIso) {
  const local = utc(r.remind_at).setZone(tz);
  const parsed = r.rrule ? parseRrule(r.rrule) : null;
  return {
    id: r.id, at: r.remind_at, local: local.toFormat("yyyy-MM-dd'T'HH:mm"),
    when: formatWhen(r.remind_at, tz, nowIso),
    repeat: parsed ? { weekdays: parsed.weekdays, interval_weeks: parsed.intervalWeeks, text: describeRepeat(r.rrule, r.local_time) } : null,
  };
}

export async function handleAppApi({ request, env, url, user, body }) {
  const D = env.DB;
  const path = url.pathname;
  const get = request.method === 'GET';
  const post = request.method === 'POST';
  const nowIso = new Date().toISOString();
  const tz = user.tz;

  // ---------- обзор: папки и список покупок ----------
  if (path === '/api/overview' && get) {
    const [folders, shopping] = await Promise.all([db.listFolders(D, user.id), db.countShopping(D, user.id)]);
    return json({ folders, shopping });
  }

  // ---------- папки ----------
  if (path === '/api/folders/create' && post) {
    const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
    if (!FOLDER_NAME_RE.test(name)) return json({ error: 'bad_name' }, 400);
    const id = await db.createFolder(D, user.id, name);
    return id ? json({ id }) : json({ error: 'exists' }, 409);
  }
  if (path === '/api/folders/rename' && post) {
    const f = await db.getFolder(D, user.id, intOr(body.id));
    if (!f) return json({ error: 'not_found' }, 404);
    if (f.kind) return json({ error: 'protected' }, 400); // «Задачи», «Разное», «Входящие» не переименовываются и не удаляются
    const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
    if (!FOLDER_NAME_RE.test(name)) return json({ error: 'bad_name' }, 400);
    const res = await db.renameFolder(D, user.id, f.id, name);
    return res === 'ok' ? json({ ok: true }) : json({ error: res }, 409);
  }
  if (path === '/api/folders/delete' && post) {
    const f = await db.getFolder(D, user.id, intOr(body.id));
    if (!f) return json({ error: 'not_found' }, 404);
    if (f.kind) return json({ error: 'protected' }, 400);
    await db.deleteFolder(D, user.id, f.id); // папка с заметками уходит в корзину
    return json({ ok: true });
  }

  // ---------- заметки ----------
  if (path === '/api/notes' && get) {
    const folderId = url.searchParams.get('folder') ? intOr(url.searchParams.get('folder')) : null;
    if (Number.isNaN(folderId)) return json({ error: 'bad_folder' }, 400);
    const q = (url.searchParams.get('q') ?? '').slice(0, 100);
    const notes = await db.notesForApp(D, user.id, { folderId, q });
    const shown = notes.slice(0, 300);
    const rems = await db.pendingRemindersForNotes(D, user.id, shown.map((n) => n.id));
    const byNote = new Map();
    for (const r of rems) if (!byNote.has(r.note_id)) byNote.set(r.note_id, r);
    return json({
      total: notes.length,
      notes: shown.map((n) => ({ ...n, reminder: byNote.has(n.id) ? reminderView(byNote.get(n.id), tz, nowIso) : null })),
    });
  }
  if (path === '/api/note' && get) {
    const n = await db.getNote(D, user.id, intOr(url.searchParams.get('id')));
    if (!n) return json({ error: 'not_found' }, 404);
    const [r] = await db.pendingRemindersForNotes(D, user.id, [n.id]);
    return json({ note: { id: n.id, text: n.text, folder_id: n.folder_id, folder: n.folder, created_at: n.created_at },
      reminder: r ? reminderView(r, tz, nowIso) : null });
  }
  if (path === '/api/notes/update' && post) {
    const id = intOr(body.id);
    const patch = {};
    if (body.text !== undefined) {
      const text = String(body.text).trim();
      if (!text || text.length > LIMITS.TEXT_MAX_CHARS) return json({ error: 'bad_text' }, 400);
      patch.text = text;
    }
    if (body.folder_id !== undefined) {
      const f = await db.getFolder(D, user.id, intOr(body.folder_id));
      if (!f) return json({ error: 'bad_folder' }, 400);
      patch.folderId = f.id;
    }
    return (await db.updateNote(D, user.id, id, patch)) ? json({ ok: true }) : json({ error: 'not_found' }, 404);
  }
  if (path === '/api/notes/toggle' && post) {
    const id = intOr(body.id);
    if (!(await db.toggleNoteDone(D, user.id, id))) return json({ error: 'not_found' }, 404);
    const n = await db.getNote(D, user.id, id);
    return json({ done: n.done, done_at: n.done_at });
  }
  if (path === '/api/notes/delete' && post) {
    return (await db.deleteNote(D, user.id, intOr(body.id))) ? json({ ok: true }) : json({ error: 'not_found' }, 404);
  }

  // ---------- напоминания ----------
  if (path === '/api/reminders/set' && post) {
    const note = await db.getNote(D, user.id, intOr(body.note_id));
    if (!note) return json({ error: 'not_found' }, 404);
    const local = String(body.local ?? '');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return json({ error: 'bad_time' }, 400);
    let remind;
    if (body.repeat) {
      const weekdays = Array.isArray(body.repeat.weekdays) ? body.repeat.weekdays.map(Number) : [];
      remind = { at: `${local}:00`, in_minutes: null, repeat: { weekdays, interval_weeks: Number(body.repeat.interval_weeks) || 1 } };
    } else {
      const when = DateTime.fromISO(local, { zone: tz });
      if (!when.isValid) return json({ error: 'bad_time' }, 400);
      if (when <= utc(nowIso)) return json({ error: 'past' }, 400);
      remind = { at: `${local}:00`, in_minutes: null, repeat: null };
    }
    const plan = planReminder(remind, tz, nowIso);
    if (!plan) return json({ error: 'bad_time' }, 400);
    await db.replaceNoteReminder(D, { userId: user.id, noteId: note.id, remindAt: plan.remindAt, rrule: plan.rrule,
      anchorDate: plan.anchorDate, localTime: plan.localTime, tz });
    const [r] = await db.pendingRemindersForNotes(D, user.id, [note.id]);
    return json({ reminder: reminderView(r, tz, nowIso) });
  }
  if (path === '/api/reminders/cancel' && post) {
    const n = await db.cancelNoteReminders(D, user.id, intOr(body.note_id));
    return json({ ok: true, cancelled: n });
  }

  // ---------- календарь месяца ----------
  if (path === '/api/calendar' && get) {
    const month = url.searchParams.get('month') ?? '';
    if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: 'bad_month' }, 400);
    const start = DateTime.fromISO(`${month}-01`, { zone: tz });
    if (!start.isValid) return json({ error: 'bad_month' }, 400);
    const end = start.plus({ months: 1 });
    const startIso = isoUtc(start), endIso = isoUtc(end);
    const days = {};
    const add = (iso, r, recurring) => {
      const l = utc(iso).setZone(tz);
      (days[l.toISODate()] ??= []).push({ note_id: r.note_id, time: l.toFormat('HH:mm'), text: r.msg ?? '', recurring });
    };
    for (const r of await db.pendingRemindersWithText(D, user.id)) {
      if (!r.rrule) {
        if (r.remind_at >= startIso && r.remind_at < endIso) add(r.remind_at, r, false);
        continue;
      }
      const { weekdays, intervalWeeks } = parseRrule(r.rrule);
      // Первое будущее срабатывание хранится в remind_at; дальше считаем по правилу
      let cur = r.remind_at >= startIso ? r.remind_at : nextRecurrence({ afterIso: startIso, tz, localTime: r.local_time, weekdays, intervalWeeks, anchorDate: r.anchor_date });
      for (let i = 0; cur && cur < endIso && i < 100; i++) {
        if (cur >= startIso) add(cur, r, true);
        cur = nextRecurrence({ afterIso: cur, tz, localTime: r.local_time, weekdays, intervalWeeks, anchorDate: r.anchor_date });
      }
    }
    for (const d of Object.keys(days)) days[d].sort((a, b) => a.time.localeCompare(b.time));
    return json({ month, days });
  }

  // ---------- корзина ----------
  if (path === '/api/trash' && get) return json(await trash.trashOverview(D, user.id));
  if (path === '/api/trash/count' && get) { const n = await trash.trashCount(D, user.id); return json({ count: n, full: n > 0 }); }
  if (path === '/api/trash/folder' && get) {
    const r = await trash.trashFolderContents(D, user.id, intOr(url.searchParams.get('id')));
    return r ? json(r) : json({ error: 'not_found' }, 404);
  }
  if (path === '/api/trash/note' && get) {
    const n = await trash.trashNote(D, user.id, intOr(url.searchParams.get('id')));
    return n ? json({ note: n }) : json({ error: 'not_found' }, 404);
  }
  if (path === '/api/trash/restore' && post) {
    const id = intOr(body.id);
    const fn = { note: trash.restoreNote, folder: trash.restoreFolder, item: trash.restoreItem, list: trash.restoreList }[body.type];
    if (!fn || Number.isNaN(id)) return json({ error: 'bad_request' }, 400);
    const res = await fn(D, user.id, id);
    return res ? json({ ok: true, ...res }) : json({ error: 'not_found' }, 404);
  }
  if (path === '/api/trash/purge' && post) {
    const id = intOr(body.id);
    if (Number.isNaN(id) || !['note', 'folder', 'item', 'list'].includes(body.type)) return json({ error: 'bad_request' }, 400);
    return (await trash.purgeEntry(D, user.id, body.type, id)) ? json({ ok: true }) : json({ error: 'not_found' }, 404);
  }
  if (path === '/api/trash/empty' && post) {
    await trash.emptyTrash(D, user.id);
    return json({ ok: true });
  }

  // ---------- .ics и Google Календарь ----------
  if (path === '/api/ics-link' && get) {
    const noteId = intOr(url.searchParams.get('note_id'));
    const note = await db.getNote(D, user.id, noteId);
    if (!note) return json({ error: 'not_found' }, 404);
    const [r] = await db.pendingRemindersForNotes(D, user.id, [noteId]);
    if (!r) return json({ error: 'no_reminder' }, 404);
    const exp = Math.floor(Date.now() / 1000) + 600;
    const sig = await signIcs(env.TG_BOT_TOKEN, noteId, user.id, exp);
    const text = r.text ?? note.text;
    return json({
      ics: `${url.origin}/ics?n=${noteId}&u=${user.id}&e=${exp}&s=${sig}`,
      google: googleCalendarUrl({ text, remindAtIso: r.remind_at, tz, rrule: r.rrule }),
    });
  }

  // ---------- списки покупок (по магазинам) ----------
  const shopView = async (key) => {
    const [sum, items] = await Promise.all([db.listShoppingLists(D, user.id), db.listShopping(D, user.id, key)]);
    return { lists: sum.lists, none: sum.none, items };
  };
  // Ключ списка из запроса: 'all', 'none' или номер своего списка
  const parseKey = async (v) => {
    if (v === undefined || v === null || v === '' || v === 'all') return 'all';
    if (v === 'none') return 'none';
    const id = intOr(v);
    return !Number.isNaN(id) && (await db.getShoppingList(D, user.id, id)) ? id : null;
  };
  const listName = (v) => {
    const t = String(v ?? '').trim().replace(/\s+/g, ' ');
    return FOLDER_NAME_RE.test(t) ? t : null;
  };

  if (path === '/api/shopping' && get) {
    const key = await parseKey(url.searchParams.get('list'));
    if (key === null) return json({ error: 'not_found' }, 404);
    return json(await shopView(key));
  }
  if (path === '/api/shopping/add' && post) {
    const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name || name.length > 60) return json({ error: 'bad_name' }, 400);
    let listId = null;
    if (body.list_id !== undefined && body.list_id !== null && body.list_id !== 'none') {
      const l = await db.getShoppingList(D, user.id, intOr(body.list_id));
      if (!l) return json({ error: 'not_found' }, 404);
      listId = l.id;
    }
    await db.addShoppingOne(D, user.id, name, listId);
    return json(await shopView((await parseKey(body.view)) ?? 'all'));
  }
  if (path === '/api/shopping/toggle' && post) {
    await db.toggleShopping(D, user.id, intOr(body.id));
    return json(await shopView((await parseKey(body.view)) ?? 'all'));
  }
  if (path === '/api/shopping/delete' && post) {
    await db.deleteShoppingItem(D, user.id, intOr(body.id));
    return json(await shopView((await parseKey(body.view)) ?? 'all'));
  }
  if (path === '/api/shopping/move' && post) {
    const to = body.list_id === null || body.list_id === 'none' ? null : intOr(body.list_id);
    if (to !== null && Number.isNaN(to)) return json({ error: 'not_found' }, 404);
    if (!(await db.moveShoppingItem(D, user.id, intOr(body.id), to))) return json({ error: 'not_found' }, 404);
    return json(await shopView((await parseKey(body.view)) ?? 'all'));
  }
  if (path === '/api/shopping/clear' && post) {
    const key = await parseKey(body.view);
    if (key === null) return json({ error: 'not_found' }, 404);
    await db.clearDoneShopping(D, user.id, key);
    return json(await shopView(key));
  }
  if (path === '/api/shopping/lists/create' && post) {
    const name = listName(body.name);
    if (!name) return json({ error: 'bad_name' }, 400);
    const l = await db.getOrCreateShoppingList(D, user.id, name);
    return json({ id: l.id, ...(await shopView(l.id)) });
  }
  if (path === '/api/shopping/lists/rename' && post) {
    const name = listName(body.name);
    if (!name) return json({ error: 'bad_name' }, 400);
    const res = await db.renameShoppingList(D, user.id, intOr(body.id), name);
    return res === 'ok' ? json(await shopView(intOr(body.id))) : json({ error: res === 'exists' ? 'exists' : 'not_found' }, res === 'exists' ? 409 : 404);
  }
  if (path === '/api/shopping/lists/delete' && post) {
    const l = await db.getShoppingList(D, user.id, intOr(body.id));
    if (!l) return json({ error: 'not_found' }, 404);
    await db.deleteShoppingList(D, user.id, l.id);
    return json(await shopView('all'));
  }

  return null;
}

// Публичная ссылка на .ics с подписью (открывается во внешнем браузере)
export async function serveIcs(env, url, verify) {
  const noteId = Number(url.searchParams.get('n'));
  const userId = Number(url.searchParams.get('u'));
  const exp = Number(url.searchParams.get('e'));
  if (!(await verify(env.TG_BOT_TOKEN, noteId, userId, exp, url.searchParams.get('s') ?? ''))) {
    return new Response('Ссылка недействительна или устарела. Откройте её заново из приложения.', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const note = await db.getNote(env.DB, userId, noteId);
  const [r] = note ? await db.pendingRemindersForNotes(env.DB, userId, [noteId]) : [];
  if (!r) return new Response('Напоминание не найдено.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const body = buildIcs({ uid: `n${noteId}r${r.id}`, text: r.text ?? note.text, remindAtIso: r.remind_at, tz: r.tz ?? 'UTC', rrule: r.rrule });
  return new Response(body, { headers: {
    'content-type': 'text/calendar; charset=utf-8',
    'content-disposition': `attachment; filename="reminder-${noteId}.ics"`,
    'cache-control': 'no-store',
  } });
}
