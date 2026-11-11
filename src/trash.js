// Корзина: просмотр, возврат и окончательное удаление.
// Удалённое хранится TRASH_DAYS дней; потом purgeOld стирает его окончательно.
import * as db from './db.js';
import { TRASH_DAYS } from './config.js';
import { nextRecurrence, parseRrule } from './timeutil.js';

const FALLBACK_FOLDER = 'Разное';
const expires = (deletedAt) => new Date(new Date(deletedAt).getTime() + TRASH_DAYS * 86400e3).toISOString();
const all = (stmt) => stmt.all().then((r) => r.results);

// ---------- что лежит в корзине ----------
export async function trashOverview(D, userId) {
  const [folders, notes, lists, items] = await Promise.all([
    all(D.prepare(`SELECT f.id, f.orig_name AS name, f.deleted_at,
                          (SELECT COUNT(*) FROM notes n WHERE n.deleted_with_folder = f.id AND n.user_id = f.user_id) AS n
                   FROM folders f WHERE f.user_id = ? AND f.deleted_at IS NOT NULL ORDER BY f.deleted_at DESC`).bind(userId)),
    all(D.prepare(`SELECT n.id, n.text, n.deleted_at, COALESCE(f.orig_name, f.name) AS folder
                   FROM notes n LEFT JOIN folders f ON f.id = n.folder_id
                   WHERE n.user_id = ? AND n.deleted_at IS NOT NULL AND n.deleted_with_folder IS NULL ORDER BY n.deleted_at DESC`).bind(userId)),
    all(D.prepare(`SELECT l.id, l.name, l.deleted_at,
                          (SELECT COUNT(*) FROM shopping_items i WHERE i.deleted_with_list = l.id AND i.user_id = l.user_id) AS n
                   FROM shopping_lists l WHERE l.user_id = ? AND l.deleted_at IS NOT NULL ORDER BY l.deleted_at DESC`).bind(userId)),
    all(D.prepare(`SELECT i.id, i.name, i.done, i.deleted_at, l.name AS list
                   FROM shopping_items i LEFT JOIN shopping_lists l ON l.id = i.list_id
                   WHERE i.user_id = ? AND i.deleted_at IS NOT NULL AND i.deleted_with_list IS NULL ORDER BY i.deleted_at DESC`).bind(userId)),
  ]);
  const withExp = (x) => ({ ...x, expires_at: expires(x.deleted_at) });
  return { days: TRASH_DAYS, folders: folders.map(withExp), notes: notes.map(withExp), lists: lists.map(withExp), items: items.map(withExp) };
}

// Сколько записей лежит в корзине (папка с заметками, список с пунктами считаются одной записью); по нему меняется значок
export async function trashCount(D, userId) {
  const r = await D.prepare(`SELECT
      (SELECT COUNT(*) FROM folders WHERE user_id = ?1 AND deleted_at IS NOT NULL)
    + (SELECT COUNT(*) FROM notes WHERE user_id = ?1 AND deleted_at IS NOT NULL AND deleted_with_folder IS NULL)
    + (SELECT COUNT(*) FROM shopping_lists WHERE user_id = ?1 AND deleted_at IS NOT NULL)
    + (SELECT COUNT(*) FROM shopping_items WHERE user_id = ?1 AND deleted_at IS NOT NULL AND deleted_with_list IS NULL) AS n`).bind(userId).first();
  return r.n;
}

export async function trashFolderContents(D, userId, folderId) {
  const f = await D.prepare('SELECT id, orig_name AS name, deleted_at FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL').bind(folderId, userId).first();
  if (!f) return null;
  const notes = await all(D.prepare(`SELECT id, text, deleted_at FROM notes WHERE user_id = ? AND deleted_with_folder = ? ORDER BY id DESC`).bind(userId, folderId));
  return { folder: { ...f, expires_at: expires(f.deleted_at) }, notes };
}

export const trashNote = (D, userId, id) =>
  D.prepare(`SELECT n.id, n.text, n.deleted_at, n.deleted_with_folder, COALESCE(f.orig_name, f.name) AS folder
             FROM notes n LEFT JOIN folders f ON f.id = n.folder_id
             WHERE n.id = ? AND n.user_id = ? AND n.deleted_at IS NOT NULL`).bind(id, userId).first()
    .then((n) => (n ? { ...n, expires_at: expires(n.deleted_at) } : null));

// ---------- возврат ----------
// После возврата напоминания приводим в порядок: разовые с прошедшим временем отменяем, повторяющиеся переносим на следующий срок
async function fixReminders(D, userId, noteIds, nowIsoStr) {
  if (!noteIds.length) return;
  const marks = noteIds.map(() => '?').join(',');
  const stale = await all(D.prepare(`SELECT id, rrule, local_time, anchor_date, tz FROM reminders
                                     WHERE user_id = ? AND status = 'pending' AND remind_at <= ? AND note_id IN (${marks})`).bind(userId, nowIsoStr, ...noteIds));
  const stmts = [];
  for (const r of stale) {
    if (!r.rrule) { stmts.push(D.prepare(`UPDATE reminders SET status = 'cancelled' WHERE id = ?`).bind(r.id)); continue; }
    const { weekdays, intervalWeeks } = parseRrule(r.rrule);
    const next = nextRecurrence({ afterIso: nowIsoStr, tz: r.tz, localTime: r.local_time, weekdays, intervalWeeks, anchorDate: r.anchor_date });
    stmts.push(next ? D.prepare('UPDATE reminders SET remind_at = ? WHERE id = ?').bind(next, r.id)
                    : D.prepare(`UPDATE reminders SET status = 'cancelled' WHERE id = ?`).bind(r.id));
  }
  if (stmts.length) await D.batch(stmts);
}

// Заметка: назад в свою папку, если она есть; заметка из удалённой папки и заметка без папки уходит в «Разное»
export async function restoreNote(D, userId, id, nowIsoStr = new Date().toISOString()) {
  const n = await D.prepare('SELECT id, folder_id, deleted_with_folder FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL').bind(id, userId).first();
  if (!n) return null;
  let target = null;
  if (n.deleted_with_folder === null && n.folder_id) target = await db.getFolder(D, userId, n.folder_id);
  if (!target) target = await db.getOrCreateFolder(D, userId, FALLBACK_FOLDER);
  await D.prepare('UPDATE notes SET folder_id = ?, deleted_at = NULL, deleted_with_folder = NULL, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(target.id, nowIsoStr, id, userId).run();
  await fixReminders(D, userId, [id], nowIsoStr);
  return { folder: target.name, folder_id: target.id };
}

// Папка: возвращается со всем содержимым; если папка с таким названием уже есть, заметки просто добавляются в неё
export async function restoreFolder(D, userId, id, nowIsoStr = new Date().toISOString()) {
  const f = await D.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL').bind(id, userId).first();
  if (!f) return null;
  const existing = await db.getFolderByName(D, userId, f.orig_name);
  const noteIds = (await all(D.prepare('SELECT id FROM notes WHERE user_id = ? AND deleted_with_folder = ?').bind(userId, id))).map((x) => x.id);
  const target = existing ? existing.id : f.id;
  const stmts = [];
  if (!existing) stmts.push(D.prepare('UPDATE folders SET name = orig_name, orig_name = NULL, deleted_at = NULL WHERE id = ?').bind(f.id));
  stmts.push(D.prepare('UPDATE notes SET folder_id = ?, deleted_at = NULL, deleted_with_folder = NULL WHERE user_id = ? AND deleted_with_folder = ?').bind(target, userId, id));
  if (existing) {
    // отдельно удалённые заметки этой папки остаются в корзине, но привязываются к уцелевшей папке
    stmts.push(D.prepare('UPDATE notes SET folder_id = ? WHERE user_id = ? AND folder_id = ?').bind(target, userId, id));
    stmts.push(D.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').bind(id, userId));
  }
  await D.batch(stmts);
  await fixReminders(D, userId, noteIds, nowIsoStr);
  return { name: f.orig_name, merged: !!existing, count: noteIds.length };
}

// Пункт покупок: в свой список, если он есть; из удалённого списка и без списка в «Без магазина»
export async function restoreItem(D, userId, id) {
  const it = await D.prepare('SELECT id, list_id, deleted_with_list FROM shopping_items WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL').bind(id, userId).first();
  if (!it) return null;
  let listId = null;
  if (it.deleted_with_list === null && it.list_id && (await db.getShoppingList(D, userId, it.list_id))) listId = it.list_id;
  await D.prepare('UPDATE shopping_items SET list_id = ?, deleted_at = NULL, deleted_with_list = NULL WHERE id = ? AND user_id = ?').bind(listId, id, userId).run();
  return { list_id: listId };
}

// Список покупок: возвращается с пунктами; если список с таким названием уже есть, пункты добавляются в него
export async function restoreList(D, userId, id) {
  const l = await D.prepare('SELECT * FROM shopping_lists WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL').bind(id, userId).first();
  if (!l) return null;
  const existing = await db.findShoppingList(D, userId, l.name);
  const count = (await D.prepare('SELECT COUNT(*) AS n FROM shopping_items WHERE user_id = ? AND deleted_with_list = ?').bind(userId, id).first()).n;
  const target = existing ? existing.id : l.id;
  const stmts = [];
  if (!existing) stmts.push(D.prepare('UPDATE shopping_lists SET deleted_at = NULL WHERE id = ?').bind(l.id));
  stmts.push(D.prepare('UPDATE shopping_items SET list_id = ?, deleted_at = NULL, deleted_with_list = NULL WHERE user_id = ? AND deleted_with_list = ?').bind(target, userId, id));
  if (existing) {
    stmts.push(D.prepare('UPDATE shopping_items SET list_id = ? WHERE user_id = ? AND list_id = ?').bind(target, userId, id));
    stmts.push(D.prepare('DELETE FROM shopping_lists WHERE id = ? AND user_id = ?').bind(id, userId));
  }
  await D.batch(stmts);
  return { name: l.name, merged: !!existing, count };
}

// ---------- окончательное удаление ----------
export async function purgeEntry(D, userId, type, id) {
  const run = (sql, ...b) => D.prepare(sql).bind(...b).run().then((r) => r.meta.changes);
  if (type === 'note') return (await run('DELETE FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL', id, userId)) >= 1;
  if (type === 'folder') {
    await run('DELETE FROM notes WHERE user_id = ? AND deleted_with_folder = ?', userId, id);
    return (await run('DELETE FROM folders WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL', id, userId)) >= 1;
  }
  if (type === 'item') return (await run('DELETE FROM shopping_items WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL', id, userId)) >= 1;
  if (type === 'list') {
    await run('DELETE FROM shopping_items WHERE user_id = ? AND deleted_with_list = ?', userId, id);
    return (await run('DELETE FROM shopping_lists WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL', id, userId)) >= 1;
  }
  return false;
}

export async function emptyTrash(D, userId) {
  await D.batch([
    D.prepare('DELETE FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL').bind(userId),
    D.prepare('DELETE FROM folders WHERE user_id = ? AND deleted_at IS NOT NULL').bind(userId),
    D.prepare('DELETE FROM shopping_items WHERE user_id = ? AND deleted_at IS NOT NULL').bind(userId),
    D.prepare('DELETE FROM shopping_lists WHERE user_id = ? AND deleted_at IS NOT NULL').bind(userId),
  ]);
}

// Раз в сутки: окончательно стираем то, что пролежало в корзине дольше TRASH_DAYS
export async function purgeExpired(D, nowIsoStr) {
  const cutoff = new Date(new Date(nowIsoStr).getTime() - TRASH_DAYS * 86400e3).toISOString();
  await D.batch([
    D.prepare('DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?').bind(cutoff),
    D.prepare('DELETE FROM folders WHERE deleted_at IS NOT NULL AND deleted_at < ?').bind(cutoff),
    D.prepare('DELETE FROM shopping_items WHERE deleted_at IS NOT NULL AND deleted_at < ?').bind(cutoff),
    D.prepare('DELETE FROM shopping_lists WHERE deleted_at IS NOT NULL AND deleted_at < ?').bind(cutoff),
  ]);
}
