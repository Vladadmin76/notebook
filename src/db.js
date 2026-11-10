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

export const deleteNote = (db, userId, noteId) =>
  db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?').bind(noteId, userId).run().then((r) => r.meta.changes === 1);
