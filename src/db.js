import { nowIso, randomToken } from './util.js';
import { START_FOLDERS, FOLDER_KINDS } from './config.js';
import { CATALOG } from './stores.js';

export const kindOf = (name) => FOLDER_KINDS[Object.keys(FOLDER_KINDS).find((k) => k.toLowerCase() === String(name).toLowerCase())] ?? null;

export const getUser = (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();

export const findUserByLabel = (db, label) =>
  db.prepare('SELECT * FROM users WHERE label = ? COLLATE NOCASE').bind(label).first();

export const listUsers = (db) =>
  db.prepare('SELECT id, name, label, tz, is_admin, status, can_write, created_at FROM users ORDER BY created_at').all()
    .then((r) => r.results);

export async function setStatus(db, id, status) {
  await db.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, id).run();
}

export async function removeUser(db, id) {
  // каскадом уходят папки, заметки, напоминания
  await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
}

export const audit = (db, actor, action, target) =>
  db.prepare('INSERT INTO audit (at, actor, action, target) VALUES (?, ?, ?, ?)')
    .bind(nowIso(), actor, action, target ?? null).run();

// ---------- приглашения ----------

export async function createInvite(db, note, createdBy) {
  const code = randomToken(18);
  await db.prepare('INSERT INTO invites (code, note, created_by, created_at) VALUES (?, ?, ?, ?)')
    .bind(code, note || null, createdBy, nowIso()).run();
  return code;
}

export const getInvite = (db, code) => db.prepare('SELECT * FROM invites WHERE code = ?').bind(code).first();

export const listOpenInvites = (db) =>
  db.prepare('SELECT code, note FROM invites WHERE used_by IS NULL AND revoked_at IS NULL ORDER BY created_at')
    .all().then((r) => r.results);

export async function revokeInviteByCode(db, code) {
  const r = await db.prepare(
    `UPDATE invites SET revoked_at = ? WHERE code = ? AND used_by IS NULL AND revoked_at IS NULL`)
    .bind(nowIso(), code).run();
  return r.meta.changes;
}

export async function revokeInvitesByNote(db, note) {
  const r = await db.prepare(
    `UPDATE invites SET revoked_at = ? WHERE note = ? COLLATE NOCASE AND used_by IS NULL AND revoked_at IS NULL`)
    .bind(nowIso(), note).run();
  return r.meta.changes;
}

export function inviteState(inv) {
  if (!inv) return 'missing';
  if (inv.revoked_at) return 'revoked';
  if (inv.used_by) return 'used';
  return 'open';
}

// Знакомство: человек открыл приглашение в Telegram и ввёл имя.
// Всё в одной транзакции (D1 batch): приглашение гасится только вместе с созданием пользователя.
// Админ (по ID из секрета) регистрируется без приглашения.
export async function registerUser(db, { id, tgName, label, tz, code, isAdmin }) {
  const now = nowIso();
  const stmts = [];
  if (isAdmin) {
    stmts.push(db.prepare(`INSERT INTO users (id, name, label, tz, is_admin, status, created_at)
                           VALUES (?, ?, ?, ?, 1, 'active', ?)`).bind(id, tgName, label, tz, now));
  } else {
    stmts.push(db.prepare(`INSERT INTO users (id, name, label, tz, is_admin, status, created_at)
                           SELECT ?, ?, ?, ?, 0, 'active', ?
                           WHERE EXISTS (SELECT 1 FROM invites WHERE code = ? AND used_by IS NULL AND revoked_at IS NULL)`)
      .bind(id, tgName, label, tz, now, code));
    stmts.push(db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL AND revoked_at IS NULL')
      .bind(id, now, code));
  }
  for (const f of START_FOLDERS) {
    stmts.push(db.prepare(`INSERT INTO folders (user_id, name, kind, created_at)
                           SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)`).bind(id, f, kindOf(f), now, id));
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message ?? e))) return { error: 'label_taken' };
    throw e;
  }
  const user = await getUser(db, id);
  return user ? { user } : { error: 'invite_unavailable' };
}

export async function updateSettings(db, id, { tz, theme }) {
  if (tz) await db.prepare('UPDATE users SET tz = ? WHERE id = ?').bind(tz, id).run();
  if (theme) await db.prepare('UPDATE users SET theme = ? WHERE id = ?').bind(theme, id).run();
}

export const markCanWrite = (db, id) => db.prepare('UPDATE users SET can_write = 1 WHERE id = ?').bind(id).run();

// ---------- папки и заметки ----------

export const listFolders = (db, userId) =>
  db.prepare(`SELECT f.id, f.name, f.kind, COUNT(n.id) AS n FROM folders f
              LEFT JOIN notes n ON n.folder_id = f.id AND n.deleted_at IS NULL
              WHERE f.user_id = ? AND f.deleted_at IS NULL GROUP BY f.id ORDER BY f.id`).bind(userId).all().then((r) => r.results);

// Названия сравниваем без учёта регистра в коде: collation NOCASE в SQLite понимает только латиницу, «Новая» и «НОВАЯ» он считает разными
export const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
export const getFolderByName = async (db, userId, name) => {
  const rows = await db.prepare('SELECT * FROM folders WHERE user_id = ? AND deleted_at IS NULL').bind(userId).all().then((r) => r.results);
  return rows.find((f) => sameName(f.name, name)) ?? null;
};

export async function getOrCreateFolder(db, userId, name) {
  const found = await getFolderByName(db, userId, name);
  if (found) return found;
  await db.prepare('INSERT OR IGNORE INTO folders (user_id, name, kind, created_at) VALUES (?, ?, ?, ?)')
    .bind(userId, name, kindOf(name), nowIso()).run();
  return getFolderByName(db, userId, name);
}

export async function insertNote(db, { userId, folderId, text, rawText, source = 'text' }) {
  const now = nowIso();
  const r = await db.prepare(`INSERT INTO notes (user_id, folder_id, text, raw_text, source, created_at, updated_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(userId, folderId, text, rawText, source, now, now).run();
  return r.meta.last_row_id;
}

// Все запросы по заметкам содержат user_id: чужие заметки недоступны
export const getNote = (db, userId, id) =>
  db.prepare(`SELECT n.*, f.name AS folder FROM notes n LEFT JOIN folders f ON f.id = n.folder_id
              WHERE n.id = ? AND n.user_id = ? AND n.deleted_at IS NULL`).bind(id, userId).first();

export const listNotes = (db, userId, limit = 10) =>
  db.prepare(`SELECT n.id, n.text, n.created_at, f.name AS folder FROM notes n
              LEFT JOIN folders f ON f.id = n.folder_id
              WHERE n.user_id = ? AND n.deleted_at IS NULL ORDER BY n.id DESC LIMIT ?`).bind(userId, limit).all().then((r) => r.results);

export const moveNote = (db, userId, noteId, folderId) =>
  db.prepare(`UPDATE notes SET folder_id = ?, updated_at = ?
              WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL)`)
    .bind(folderId, nowIso(), noteId, userId, folderId, userId).run().then((r) => r.meta.changes === 1);

// Удаление заметки: уходит в корзину (напоминания остаются, но не срабатывают, пока заметка в корзине)
export const deleteNote = (db, userId, noteId) =>
  db.prepare('UPDATE notes SET deleted_at = ?, deleted_with_folder = NULL WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .bind(nowIso(), noteId, userId).run().then((r) => r.meta.changes >= 1);

// ---------- напоминания ----------

export async function insertReminder(db, { userId, noteId, remindAt, rrule = null, anchorDate = null, localTime = null, tz, text = null }) {
  const r = await db.prepare(`INSERT INTO reminders (user_id, note_id, remind_at, rrule, anchor_date, local_time, tz, text, status)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
    .bind(userId, noteId, remindAt, rrule, anchorDate, localTime, tz, text).run();
  return r.meta.last_row_id;
}

export const dueReminders = (db, nowIso, limit) =>
  db.prepare(`SELECT r.*, COALESCE(r.text, n.text) AS msg, u.status AS ustatus
              FROM reminders r JOIN users u ON u.id = r.user_id LEFT JOIN notes n ON n.id = r.note_id
              WHERE r.status = 'pending' AND r.remind_at <= ? AND (n.id IS NULL OR n.deleted_at IS NULL) ORDER BY r.remind_at LIMIT ?`)
    .bind(nowIso, limit).all().then((r) => r.results);

// «Захват» напоминания: сработает только один из параллельных вызовов (сравниваем старое время)
export const claimReminder = (db, r, nextAt, nowIso) => (nextAt
  ? db.prepare(`UPDATE reminders SET remind_at = ?, sent_at = ? WHERE id = ? AND status = 'pending' AND remind_at = ?`)
      .bind(nextAt, nowIso, r.id, r.remind_at)
  : db.prepare(`UPDATE reminders SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'pending' AND remind_at = ?`)
      .bind(nowIso, r.id, r.remind_at)
).run().then((x) => x.meta.changes === 1);

export const revertReminder = (db, r) =>
  db.prepare(`UPDATE reminders SET status = 'pending', remind_at = ? WHERE id = ?`).bind(r.remind_at, r.id).run();

export const cancelReminder = (db, id) =>
  db.prepare(`UPDATE reminders SET status = 'cancelled' WHERE id = ?`).bind(id).run();

export const getReminder = (db, userId, id) =>
  db.prepare(`SELECT r.*, COALESCE(r.text, n.text) AS msg FROM reminders r LEFT JOIN notes n ON n.id = r.note_id
              WHERE r.id = ? AND r.user_id = ?`).bind(id, userId).first();

export const listPendingReminders = (db, userId, limit = 20) =>
  db.prepare(`SELECT r.id, r.remind_at, r.rrule, r.local_time, r.tz, COALESCE(r.text, n.text) AS msg
              FROM reminders r LEFT JOIN notes n ON n.id = r.note_id
              WHERE r.user_id = ? AND r.status = 'pending' AND (n.id IS NULL OR n.deleted_at IS NULL) ORDER BY r.remind_at LIMIT ?`)
    .bind(userId, limit).all().then((r) => r.results);

export const cancelNoteReminders = (db, userId, noteId) =>
  db.prepare(`UPDATE reminders SET status = 'cancelled' WHERE user_id = ? AND note_id = ? AND status = 'pending'`)
    .bind(userId, noteId).run().then((r) => r.meta.changes);

export const hasPendingReminder = (db, userId, noteId) =>
  db.prepare(`SELECT 1 AS x FROM reminders WHERE user_id = ? AND note_id = ? AND status = 'pending' LIMIT 1`)
    .bind(userId, noteId).first().then(Boolean);

// ---------- списки покупок (по магазинам) ----------
// listKey: 'all' (все списки), 'none' («Без магазина») или номер списка

export const listShoppingLists = async (db, userId) => {
  const lists = await db.prepare(`SELECT l.id, l.name, COALESCE(SUM(i.done = 0), 0) AS open, COALESCE(SUM(i.done = 1), 0) AS done
                                  FROM shopping_lists l LEFT JOIN shopping_items i ON i.list_id = l.id AND i.deleted_at IS NULL
                                  WHERE l.user_id = ? AND l.deleted_at IS NULL GROUP BY l.id ORDER BY l.name COLLATE NOCASE`).bind(userId).all().then((r) => r.results);
  const none = await db.prepare(`SELECT COALESCE(SUM(done = 0), 0) AS open, COALESCE(SUM(done = 1), 0) AS done
                                 FROM shopping_items WHERE user_id = ? AND list_id IS NULL AND deleted_at IS NULL`).bind(userId).first();
  return { lists, none };
};

export const findShoppingList = async (db, userId, name) => {
  const rows = await db.prepare('SELECT * FROM shopping_lists WHERE user_id = ? AND deleted_at IS NULL').bind(userId).all().then((r) => r.results);
  return rows.find((l) => sameName(l.name, name)) ?? null;
};

export const getShoppingList = (db, userId, id) =>
  db.prepare('SELECT * FROM shopping_lists WHERE id = ? AND user_id = ? AND deleted_at IS NULL').bind(id, userId).first();

export async function getOrCreateShoppingList(db, userId, name) {
  const found = await findShoppingList(db, userId, name);
  if (found) return found;
  await db.prepare('INSERT OR IGNORE INTO shopping_lists (user_id, name, created_at) VALUES (?, ?, ?)').bind(userId, name, nowIso()).run();
  return findShoppingList(db, userId, name);
}

export async function renameShoppingList(db, userId, id, name) {
  const clash = await findShoppingList(db, userId, name);
  if (clash && clash.id !== id) return 'exists';
  try {
    const r = await db.prepare('UPDATE shopping_lists SET name = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL').bind(name, id, userId).run();
    return r.meta.changes >= 1 ? 'ok' : 'missing';
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message ?? e))) return 'exists';
    throw e;
  }
}

// Удаление списка: список вместе с пунктами уходит в корзину
export const deleteShoppingList = (db, userId, id) => {
  const now = nowIso();
  return db.batch([
    db.prepare('UPDATE shopping_items SET deleted_at = ?, deleted_with_list = ? WHERE list_id = ? AND user_id = ? AND deleted_at IS NULL').bind(now, id, id, userId),
    db.prepare('UPDATE shopping_lists SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL').bind(now, id, userId),
  ]);
};

// Добавляет пункты { name, listId }. Повтор отсеивается только внутри одного списка: один товар можно держать в двух магазинах.
export async function addShoppingItems(db, userId, items) {
  const current = await db.prepare('SELECT name, list_id FROM shopping_items WHERE user_id = ? AND done = 0 AND deleted_at IS NULL').bind(userId).all()
    .then((r) => new Set(r.results.map((x) => `${x.list_id ?? 'none'}|${x.name.toLowerCase()}`)));
  const added = [], existing = [];
  const now = nowIso();
  const stmts = [];
  for (const it of items) {
    const key = `${it.listId ?? 'none'}|${it.name.toLowerCase()}`;
    if (current.has(key)) { existing.push(it); continue; }
    current.add(key);
    added.push(it);
    stmts.push(db.prepare('INSERT INTO shopping_items (user_id, name, list_id, done, created_at) VALUES (?, ?, ?, 0, ?)').bind(userId, it.name, it.listId ?? null, now));
  }
  if (stmts.length) await db.batch(stmts);
  return { added, existing };
}

// Некупленные сверху (в порядке добавления), купленные внизу; при 'all' пункты сгруппированы по магазинам («Без магазина» первой)
export async function listShopping(db, userId, listKey = 'all') {
  const where = listKey === 'all' ? '' : listKey === 'none' ? 'AND i.list_id IS NULL' : 'AND i.list_id = ?';
  const stmt = db.prepare(`SELECT i.id, i.name, i.done, i.list_id, l.name AS list_name
                           FROM shopping_items i LEFT JOIN shopping_lists l ON l.id = i.list_id
                           WHERE i.user_id = ? AND i.deleted_at IS NULL ${where}
                           ORDER BY (l.name IS NOT NULL), l.name COLLATE NOCASE, i.done, CASE WHEN i.done = 0 THEN i.id END, i.done_at DESC`);
  const bound = typeof listKey === 'number' ? stmt.bind(userId, listKey) : stmt.bind(userId);
  return bound.all().then((r) => r.results);
}

export const toggleShopping = (db, userId, id) =>
  db.prepare(`UPDATE shopping_items SET done = 1 - done, done_at = CASE WHEN done = 0 THEN ? ELSE NULL END
              WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).bind(nowIso(), id, userId).run().then((r) => r.meta.changes === 1);

export const moveShoppingItem = (db, userId, id, listId) =>
  db.prepare(`UPDATE shopping_items SET list_id = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL
              AND (? IS NULL OR EXISTS (SELECT 1 FROM shopping_lists WHERE id = ? AND user_id = ? AND deleted_at IS NULL))`)
    .bind(listId, id, userId, listId, listId, userId).run().then((r) => r.meta.changes === 1);

export const clearDoneShopping = (db, userId, listKey = 'all') => {
  const where = listKey === 'all' ? '' : listKey === 'none' ? 'AND list_id IS NULL' : 'AND list_id = ?';
  // «Очистить купленное»: купленное уходит в корзину
  const stmt = db.prepare(`UPDATE shopping_items SET deleted_at = '${nowIso()}', deleted_with_list = NULL WHERE user_id = ? AND done = 1 AND deleted_at IS NULL ${where}`);
  return (typeof listKey === 'number' ? stmt.bind(userId, listKey) : stmt.bind(userId)).run().then((r) => r.meta.changes);
};

// ---------- приложение: папки, заметки, покупки ----------

export const countShopping = (db, userId) =>
  db.prepare('SELECT COALESCE(SUM(done = 0), 0) AS open, COALESCE(SUM(done = 1), 0) AS done FROM shopping_items WHERE user_id = ? AND deleted_at IS NULL')
    .bind(userId).first();

export const getFolder = (db, userId, id) =>
  db.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NULL').bind(id, userId).first();

export async function createFolder(db, userId, name) {
  if (await getFolderByName(db, userId, name)) return null; // уже есть (в любом регистре)
  try {
    const r = await db.prepare('INSERT INTO folders (user_id, name, kind, created_at) VALUES (?, ?, ?, ?)').bind(userId, name, kindOf(name), nowIso()).run();
    return r.meta.last_row_id;
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message ?? e))) return null;
    throw e;
  }
}

export async function renameFolder(db, userId, id, name) {
  const clash = await getFolderByName(db, userId, name);
  if (clash && clash.id !== id) return 'exists';
  try {
    const r = await db.prepare('UPDATE folders SET name = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL').bind(name, id, userId).run();
    return r.meta.changes === 1 ? 'ok' : 'missing';
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message ?? e))) return 'exists';
    throw e;
  }
}

// Удаление папки: папка вместе с заметками уходит в корзину. Название освобождается (в name на время корзины служебное), настоящее лежит в orig_name.
export async function deleteFolder(db, userId, id) {
  const now = nowIso();
  await db.batch([
    db.prepare('UPDATE notes SET deleted_at = ?, deleted_with_folder = ? WHERE folder_id = ? AND user_id = ? AND deleted_at IS NULL').bind(now, id, id, userId),
    db.prepare(`UPDATE folders SET orig_name = name, name = name || ' [в корзине ' || id || ']', deleted_at = ?
                WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).bind(now, id, userId),
  ]);
}

// Заметки пользователя (новые сверху); поиск выполняет код, потому что SQLite не умеет регистронезависимый поиск по кириллице
export async function notesForApp(db, userId, { folderId = null, q = '', limit = 1000 } = {}) {
  const base = `SELECT n.id, n.text, n.created_at, n.updated_at, n.done, n.done_at, n.folder_id, f.name AS folder, f.kind AS kind
                FROM notes n LEFT JOIN folders f ON f.id = n.folder_id WHERE n.user_id = ? AND n.deleted_at IS NULL`;
  const rows = await (folderId
    ? db.prepare(`${base} AND n.folder_id = ? ORDER BY n.id DESC LIMIT ?`).bind(userId, folderId, limit)
    : db.prepare(`${base} ORDER BY n.id DESC LIMIT ?`).bind(userId, limit)).all().then((r) => r.results);
  const needle = q.trim().toLowerCase();
  return needle ? rows.filter((n) => n.text.toLowerCase().includes(needle)) : rows;
}

export const pendingRemindersForNotes = (db, userId, noteIds) => {
  if (!noteIds.length) return Promise.resolve([]);
  const marks = noteIds.map(() => '?').join(',');
  return db.prepare(`SELECT id, note_id, remind_at, rrule, local_time, tz, text FROM reminders
                     WHERE user_id = ? AND status = 'pending' AND note_id IN (${marks}) ORDER BY remind_at`)
    .bind(userId, ...noteIds).all().then((r) => r.results);
};

export const pendingRemindersWithText = (db, userId) =>
  db.prepare(`SELECT r.id, r.note_id, r.remind_at, r.rrule, r.local_time, r.anchor_date, r.tz, COALESCE(r.text, n.text) AS msg
              FROM reminders r LEFT JOIN notes n ON n.id = r.note_id
              WHERE r.user_id = ? AND r.status = 'pending' AND (n.id IS NULL OR n.deleted_at IS NULL) ORDER BY r.remind_at LIMIT 500`).bind(userId).all().then((r) => r.results);

export async function updateNote(db, userId, id, { text, folderId }) {
  const sets = [], vals = [];
  if (text !== undefined) { sets.push('text = ?'); vals.push(text); }
  if (folderId !== undefined) { sets.push('folder_id = ?'); vals.push(folderId); }
  if (!sets.length) return false;
  sets.push('updated_at = ?'); vals.push(nowIso());
  const stmts = [db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).bind(...vals, id, userId)];
  // У напоминания своя короткая копия текста (reminders.text). После правки заметки её сбрасываем:
  // напоминание, календарная ссылка и «Отложить» берут тогда исправленный текст заметки.
  if (text !== undefined) stmts.push(db.prepare(`UPDATE reminders SET text = NULL WHERE note_id = ? AND user_id = ? AND status = 'pending'`).bind(id, userId));
  const res = await db.batch(stmts);
  return res[0].meta.changes === 1;
}

export const addShoppingOne = (db, userId, name, listId = null) => addShoppingItems(db, userId, [{ name, listId }]);

export const deleteShoppingItem = (db, userId, id) =>
  db.prepare('UPDATE shopping_items SET deleted_at = ?, deleted_with_list = NULL WHERE id = ? AND user_id = ? AND deleted_at IS NULL').bind(nowIso(), id, userId).run().then((r) => r.meta.changes === 1);

// Заменяем напоминание заметки: старые активные отменяем, создаём новое
export async function replaceNoteReminder(db, { userId, noteId, remindAt, rrule = null, anchorDate = null, localTime = null, tz, text = null }) {
  await db.batch([
    db.prepare(`UPDATE reminders SET status = 'cancelled' WHERE user_id = ? AND note_id = ? AND status = 'pending'`).bind(userId, noteId),
    db.prepare(`INSERT INTO reminders (user_id, note_id, remind_at, rrule, anchor_date, local_time, tz, text, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).bind(userId, noteId, remindAt, rrule, anchorDate, localTime, tz, text),
  ]);
}


// ---------- задачи, входящие, состояние диалога ----------

export const toggleNoteDone = (db, userId, id) =>
  db.prepare(`UPDATE notes SET done = 1 - done, done_at = CASE WHEN done = 0 THEN ? ELSE NULL END, updated_at = ?
              WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).bind(nowIso(), nowIso(), id, userId).run().then((r) => r.meta.changes >= 1);

export const setState = (db, userId, kind, noteId, expiresAt) =>
  db.prepare(`INSERT INTO user_state (user_id, kind, note_id, expires_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET kind = excluded.kind, note_id = excluded.note_id, expires_at = excluded.expires_at`)
    .bind(userId, kind, noteId, expiresAt).run();

export const getState = async (db, userId, nowIsoStr = nowIso()) => {
  const st = await db.prepare('SELECT * FROM user_state WHERE user_id = ?').bind(userId).first();
  if (!st) return null;
  if (st.expires_at <= nowIsoStr) { await clearState(db, userId); return null; }
  return st;
};
export const clearState = (db, userId) => db.prepare('DELETE FROM user_state WHERE user_id = ?').bind(userId).run();

export const appendToNote = (db, userId, id, extra, maxLen) =>
  db.prepare(`UPDATE notes SET text = text || char(10) || ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND length(text) + 1 + length(?) <= ?`)
    .bind(extra, nowIso(), id, userId, extra, maxLen).run().then((r) => r.meta.changes >= 1);

export const findNoteByText = (db, userId, folderId, text) =>
  db.prepare('SELECT id FROM notes WHERE user_id = ? AND folder_id = ? AND text = ? AND deleted_at IS NULL LIMIT 1').bind(userId, folderId, text).first();

// Люди, у которых во «Входящих» что-то лежит, и сколько
export const inboxDigestCandidates = (db) =>
  db.prepare(`SELECT u.id, u.tz, u.inbox_digest_on, COUNT(n.id) AS c
              FROM users u JOIN folders f ON f.user_id = u.id AND f.kind = 'inbox' AND f.deleted_at IS NULL
              JOIN notes n ON n.folder_id = f.id AND n.deleted_at IS NULL
              WHERE u.status = 'active' GROUP BY u.id`).all().then((r) => r.results);

export const claimDigest = (db, userId, today) =>
  db.prepare(`UPDATE users SET inbox_digest_on = ? WHERE id = ? AND (inbox_digest_on IS NULL OR inbox_digest_on != ?)`)
    .bind(today, userId, today).run().then((r) => r.meta.changes === 1);

// Уборка: старые отправленные и отменённые напоминания (90 дней) и просроченные ожидания комментария
export async function purgeOld(db, nowIsoStr) {
  const cutoff = new Date(new Date(nowIsoStr).getTime() - 90 * 86400e3).toISOString();
  await db.batch([
    db.prepare(`DELETE FROM reminders WHERE status IN ('sent', 'cancelled') AND COALESCE(sent_at, remind_at) < ?`).bind(cutoff),
    db.prepare('DELETE FROM user_state WHERE expires_at < ?').bind(nowIsoStr),
  ]);
  const { purgeExpired } = await import('./trash.js'); // корзина: окончательно стираем просроченное
  await purgeExpired(db, nowIsoStr);
}


// ---------- магазины человека ----------
const parseAliases = (x) => { try { const a = JSON.parse(x); return Array.isArray(a) ? a.filter((v) => typeof v === 'string') : []; } catch { return []; } };

export const listUserStores = (db, userId) =>
  db.prepare('SELECT id, name, custom, favorite, aliases FROM user_stores WHERE user_id = ? ORDER BY id').bind(userId).all()
    .then((r) => r.results.map((x) => ({ ...x, custom: !!x.custom, favorite: !!x.favorite, aliases: parseAliases(x.aliases) })));

export async function upsertUserStore(db, userId, name, { custom = false, favorite }) {
  const rows = await listUserStores(db, userId);
  const found = rows.find((r) => sameName(r.name, name));
  if (found) {
    if (favorite !== undefined) await db.prepare('UPDATE user_stores SET favorite = ? WHERE id = ? AND user_id = ?').bind(favorite ? 1 : 0, found.id, userId).run();
    return found.name;
  }
  await db.prepare('INSERT INTO user_stores (user_id, name, custom, favorite, aliases, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(userId, name, custom ? 1 : 0, favorite ? 1 : 0, '[]', nowIso()).run();
  return name;
}

// Запоминаем новое написание магазина (например «Костка» для Costco)
export async function learnStoreAlias(db, userId, canonical, alias, max = 12) {
  const a = String(alias).trim();
  if (!a || a.length > 30 || sameName(a, canonical)) return false;
  const rows = await listUserStores(db, userId);
  const found = rows.find((r) => sameName(r.name, canonical));
  if (found) {
    if (found.aliases.some((x) => sameName(x, a)) || found.aliases.length >= max) return false;
    await db.prepare('UPDATE user_stores SET aliases = ? WHERE id = ? AND user_id = ?').bind(JSON.stringify([...found.aliases, a]), found.id, userId).run();
  } else {
    await db.prepare('INSERT INTO user_stores (user_id, name, custom, favorite, aliases, created_at) VALUES (?, ?, 0, 0, ?, ?)')
      .bind(userId, canonical, JSON.stringify([a]), nowIso()).run();
  }
  return true;
}

export const deleteCustomStore = (db, userId, id) =>
  db.prepare('DELETE FROM user_stores WHERE id = ? AND user_id = ? AND custom = 1').bind(id, userId).run().then((r) => r.meta.changes === 1);

export const shoppingListNames = (db, userId) =>
  db.prepare('SELECT name FROM shopping_lists WHERE user_id = ? AND deleted_at IS NULL').bind(userId).all().then((r) => r.results.map((x) => x.name));


// ---------- избранные магазины = списки покупок ----------
const catalogName = (name) => CATALOG.find((c) => sameName(c.name, name))?.name ?? null;

// Сколько пунктов в списке (купленные тоже считаются, пока их не очистили)
export const countListItems = (db, userId, listId) =>
  db.prepare('SELECT COUNT(*) AS n FROM shopping_items WHERE user_id = ? AND list_id = ? AND deleted_at IS NULL').bind(userId, listId).first().then((r) => r.n);

// Магазин в избранное: у него появляется список покупок. Свой (не из перечня) магазин создаётся здесь же.
export async function addFavoriteStore(db, userId, name, { custom } = {}) {
  const canon = catalogName(name);
  const isCustom = canon ? false : (custom ?? true);
  const finalName = canon ?? name;
  await upsertUserStore(db, userId, finalName, { custom: isCustom, favorite: true });
  const list = await getOrCreateShoppingList(db, userId, finalName);
  return { name: finalName, list };
}

// Убрать из избранного можно только когда список пуст; пустой список исчезает вместе с магазином
export async function removeFavoriteStore(db, userId, name) {
  const list = await findShoppingList(db, userId, name);
  const count = list ? await countListItems(db, userId, list.id) : 0;
  if (count > 0) return { ok: false, error: 'not_empty', count, name: list.name };
  if (list) await db.prepare('DELETE FROM shopping_lists WHERE id = ? AND user_id = ?').bind(list.id, userId).run();
  const rows = await listUserStores(db, userId);
  const row = rows.find((r) => sameName(r.name, name));
  if (row) {
    if (row.custom) await db.prepare('DELETE FROM user_stores WHERE id = ? AND user_id = ?').bind(row.id, userId).run();
    else await db.prepare('UPDATE user_stores SET favorite = 0 WHERE id = ? AND user_id = ?').bind(row.id, userId).run();
  }
  return { ok: true };
}

// Приводим в соответствие: каждый список покупок это избранный магазин, у каждого избранного магазина есть список
export async function syncStoresWithLists(db, userId) {
  const [rows, listNames] = await Promise.all([listUserStores(db, userId), shoppingListNames(db, userId)]);
  for (const ln of listNames) {
    const row = rows.find((r) => sameName(r.name, ln));
    if (!row) await upsertUserStore(db, userId, catalogName(ln) ?? ln, { custom: !catalogName(ln), favorite: true });
    else if (!row.favorite) await upsertUserStore(db, userId, row.name, { favorite: true });
  }
  for (const r of rows) if (r.favorite && !listNames.some((ln) => sameName(ln, r.name))) await getOrCreateShoppingList(db, userId, r.name);
}

// Переименовать можно только свой магазин; меняется и название списка
export async function renameCustomStore(db, userId, oldName, newName) {
  const rows = await listUserStores(db, userId);
  const row = rows.find((r) => r.custom && sameName(r.name, oldName));
  if (!row) return 'protected';
  const clash = rows.find((r) => sameName(r.name, newName) && r.id !== row.id) || CATALOG.some((c) => sameName(c.name, newName) && !sameName(c.name, oldName));
  if (clash) return 'exists';
  const list = await findShoppingList(db, userId, oldName);
  const stmts = [db.prepare('UPDATE user_stores SET name = ? WHERE id = ? AND user_id = ?').bind(newName, row.id, userId)];
  if (list) stmts.push(db.prepare('UPDATE shopping_lists SET name = ? WHERE id = ? AND user_id = ?').bind(newName, list.id, userId));
  await db.batch(stmts);
  return 'ok';
}
