import { nowIso, randomToken } from './util.js';
import { START_FOLDERS } from './config.js';

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
    stmts.push(db.prepare(`INSERT INTO folders (user_id, name, created_at)
                           SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)`).bind(id, f, now, id));
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
  db.prepare(`SELECT f.id, f.name, COUNT(n.id) AS n FROM folders f
              LEFT JOIN notes n ON n.folder_id = f.id
              WHERE f.user_id = ? GROUP BY f.id ORDER BY f.id`).bind(userId).all().then((r) => r.results);

export const getFolderByName = (db, userId, name) =>
  db.prepare('SELECT * FROM folders WHERE user_id = ? AND name = ? COLLATE NOCASE').bind(userId, name).first();

export async function getOrCreateFolder(db, userId, name) {
  await db.prepare('INSERT OR IGNORE INTO folders (user_id, name, created_at) VALUES (?, ?, ?)')
    .bind(userId, name, nowIso()).run();
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
              WHERE n.id = ? AND n.user_id = ?`).bind(id, userId).first();

export const listNotes = (db, userId, limit = 10) =>
  db.prepare(`SELECT n.id, n.text, n.created_at, f.name AS folder FROM notes n
              LEFT JOIN folders f ON f.id = n.folder_id
              WHERE n.user_id = ? ORDER BY n.id DESC LIMIT ?`).bind(userId, limit).all().then((r) => r.results);

export const moveNote = (db, userId, noteId, folderId) =>
  db.prepare(`UPDATE notes SET folder_id = ?, updated_at = ?
              WHERE id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM folders WHERE id = ? AND user_id = ?)`)
    .bind(folderId, nowIso(), noteId, userId, folderId, userId).run().then((r) => r.meta.changes === 1);

// При удалении заметки база каскадом удаляет её напоминания, и счётчик изменённых строк бывает больше 1: считаем успехом любое ненулевое значение
export const deleteNote = (db, userId, noteId) =>
  db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?').bind(noteId, userId).run().then((r) => r.meta.changes >= 1);

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
              WHERE r.status = 'pending' AND r.remind_at <= ? ORDER BY r.remind_at LIMIT ?`)
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
              WHERE r.user_id = ? AND r.status = 'pending' ORDER BY r.remind_at LIMIT ?`)
    .bind(userId, limit).all().then((r) => r.results);

export const cancelNoteReminders = (db, userId, noteId) =>
  db.prepare(`UPDATE reminders SET status = 'cancelled' WHERE user_id = ? AND note_id = ? AND status = 'pending'`)
    .bind(userId, noteId).run().then((r) => r.meta.changes);

export const hasPendingReminder = (db, userId, noteId) =>
  db.prepare(`SELECT 1 AS x FROM reminders WHERE user_id = ? AND note_id = ? AND status = 'pending' LIMIT 1`)
    .bind(userId, noteId).first().then(Boolean);

// ---------- список покупок ----------

// Добавляет пункты; те, что уже есть в списке некупленными, пропускаем. Возвращает { added, existing }.
export async function addShoppingItems(db, userId, names) {
  const current = await db.prepare('SELECT name FROM shopping_items WHERE user_id = ? AND done = 0').bind(userId).all()
    .then((r) => new Set(r.results.map((x) => x.name.toLowerCase())));
  const added = [], existing = [];
  const now = nowIso();
  const stmts = [];
  for (const name of names) {
    if (current.has(name.toLowerCase())) { existing.push(name); continue; }
    current.add(name.toLowerCase());
    added.push(name);
    stmts.push(db.prepare('INSERT INTO shopping_items (user_id, name, done, created_at) VALUES (?, ?, 0, ?)').bind(userId, name, now));
  }
  if (stmts.length) await db.batch(stmts);
  return { added, existing };
}

// Некупленные сверху (в порядке добавления), купленные внизу (недавно купленные выше)
export const listShopping = (db, userId) =>
  db.prepare(`SELECT id, name, done FROM shopping_items WHERE user_id = ?
              ORDER BY done, CASE WHEN done = 0 THEN id END, done_at DESC`).bind(userId).all().then((r) => r.results);

export const toggleShopping = (db, userId, id) =>
  db.prepare(`UPDATE shopping_items SET done = 1 - done, done_at = CASE WHEN done = 0 THEN ? ELSE NULL END
              WHERE id = ? AND user_id = ?`).bind(nowIso(), id, userId).run().then((r) => r.meta.changes === 1);

export const clearDoneShopping = (db, userId) =>
  db.prepare('DELETE FROM shopping_items WHERE user_id = ? AND done = 1').bind(userId).run().then((r) => r.meta.changes);

// ---------- приложение: папки, заметки, покупки ----------

export const countShopping = (db, userId) =>
  db.prepare('SELECT COALESCE(SUM(done = 0), 0) AS open, COALESCE(SUM(done = 1), 0) AS done FROM shopping_items WHERE user_id = ?')
    .bind(userId).first();

export const getFolder = (db, userId, id) =>
  db.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?').bind(id, userId).first();

export async function createFolder(db, userId, name) {
  try {
    const r = await db.prepare('INSERT INTO folders (user_id, name, created_at) VALUES (?, ?, ?)').bind(userId, name, nowIso()).run();
    return r.meta.last_row_id;
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message ?? e))) return null;
    throw e;
  }
}

export async function renameFolder(db, userId, id, name) {
  try {
    const r = await db.prepare('UPDATE folders SET name = ? WHERE id = ? AND user_id = ?').bind(name, id, userId).run();
    return r.meta.changes === 1 ? 'ok' : 'missing';
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message ?? e))) return 'exists';
    throw e;
  }
}

// Удаление папки: заметки уходят в «Разное»
export async function deleteFolder(db, userId, id, fallbackName) {
  const fb = await getOrCreateFolder(db, userId, fallbackName);
  await db.batch([
    db.prepare('UPDATE notes SET folder_id = ? WHERE folder_id = ? AND user_id = ?').bind(fb.id, id, userId),
    db.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').bind(id, userId),
  ]);
}

// Заметки пользователя (новые сверху); поиск выполняет код, потому что SQLite не умеет регистронезависимый поиск по кириллице
export async function notesForApp(db, userId, { folderId = null, q = '', limit = 1000 } = {}) {
  const base = `SELECT n.id, n.text, n.created_at, n.updated_at, n.folder_id, f.name AS folder
                FROM notes n LEFT JOIN folders f ON f.id = n.folder_id WHERE n.user_id = ?`;
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
              WHERE r.user_id = ? AND r.status = 'pending' ORDER BY r.remind_at LIMIT 500`).bind(userId).all().then((r) => r.results);

export async function updateNote(db, userId, id, { text, folderId }) {
  const sets = [], vals = [];
  if (text !== undefined) { sets.push('text = ?'); vals.push(text); }
  if (folderId !== undefined) { sets.push('folder_id = ?'); vals.push(folderId); }
  if (!sets.length) return false;
  sets.push('updated_at = ?'); vals.push(nowIso());
  const r = await db.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...vals, id, userId).run();
  return r.meta.changes === 1;
}

export const addShoppingOne = (db, userId, name) => addShoppingItems(db, userId, [name]);

export const deleteShoppingItem = (db, userId, id) =>
  db.prepare('DELETE FROM shopping_items WHERE id = ? AND user_id = ?').bind(id, userId).run().then((r) => r.meta.changes === 1);

// Заменяем напоминание заметки: старые активные отменяем, создаём новое
export async function replaceNoteReminder(db, { userId, noteId, remindAt, rrule = null, anchorDate = null, localTime = null, tz, text = null }) {
  await db.batch([
    db.prepare(`UPDATE reminders SET status = 'cancelled' WHERE user_id = ? AND note_id = ? AND status = 'pending'`).bind(userId, noteId),
    db.prepare(`INSERT INTO reminders (user_id, note_id, remind_at, rrule, anchor_date, local_time, tz, text, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).bind(userId, noteId, remindAt, rrule, anchorDate, localTime, tz, text),
  ]);
}
