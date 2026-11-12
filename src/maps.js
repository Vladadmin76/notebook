// Интеллект-карты: проверка и сохранение. Дерево приходит от браузера, поэтому пересобирается заново из разрешённых полей.
const MAX_NODES = 600;
const MAX_TOPIC = 200;
const MAX_DEPTH = 40;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Возвращает чистое дерево или null, если данные негодные
export function cleanTree(raw) {
  let count = 0;
  const walk = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > MAX_DEPTH || ++count > MAX_NODES) return null;
    const id = typeof n.id === 'string' && /^[\w-]{1,40}$/.test(n.id) ? n.id : null;
    if (!id) return null;
    const out = { id, topic: String(n.topic ?? '').slice(0, MAX_TOPIC) };
    if (n.expanded === false) out.expanded = false;
    const bg = n.style && COLOR_RE.test(n.style.background) ? n.style.background : null;
    const fg = n.style && COLOR_RE.test(n.style.color) ? n.style.color : null;
    if (bg || fg) out.style = { ...(bg ? { background: bg } : {}), ...(fg ? { color: fg } : {}) };
    if (COLOR_RE.test(n.branchColor)) out.branchColor = n.branchColor; // цвет линии, которая ведёт к этой ветке
    if (depth === 1 && n.direction !== undefined) out.direction = n.direction === 0 ? 0 : 1; // сторона ветки от центра
    if (Array.isArray(n.children) && n.children.length) {
      out.children = [];
      for (const c of n.children) {
        const k = walk({ ...c, direction: depth === 0 ? c.direction : undefined }, depth + 1);
        if (!k) return null;
        out.children.push(k);
      }
    }
    return out;
  };
  const root = walk(raw, 0);
  return root;
}

export const titleOf = (tree) => (tree.topic || '').trim().slice(0, 60);

export async function listMaps(db, userId) {
  return (await db.prepare('SELECT id, title, updated_at FROM mind_maps WHERE user_id = ? ORDER BY updated_at DESC').bind(userId).all()).results;
}
export async function getMap(db, userId, id) {
  return db.prepare('SELECT id, title, data, updated_at FROM mind_maps WHERE id = ? AND user_id = ?').bind(id, userId).first();
}
export async function createMap(db, userId, tree, nowIso) {
  const r = await db.prepare('INSERT INTO mind_maps (user_id, title, data, created_at, updated_at) VALUES (?,?,?,?,?)')
    .bind(userId, titleOf(tree), JSON.stringify({ nodeData: tree }), nowIso, nowIso).run();
  return r.meta.last_row_id;
}
export async function saveMap(db, userId, id, tree, nowIso) {
  const r = await db.prepare('UPDATE mind_maps SET title = ?, data = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(titleOf(tree), JSON.stringify({ nodeData: tree }), nowIso, id, userId).run();
  return r.meta.changes >= 1;
}
export async function deleteMap(db, userId, id) {
  const r = await db.prepare('DELETE FROM mind_maps WHERE id = ? AND user_id = ?').bind(id, userId).run();
  return r.meta.changes >= 1;
}
