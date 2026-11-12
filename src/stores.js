// Перечень известных американских магазинов и сопоставление услышанного названия с ним.
// Нужно, чтобы «Костко», «Костка» и «Costco» были одним списком покупок, а не тремя.

// Основные сети Калифорнии и Техаса; перечень составлен по открытым источникам (доли рынка, число магазинов) и проверен.
// Русские написания добавлены заранее; новые бот запоминает сам.
export const CATALOG = [
  { name: 'Costco', group: 'Продукты и универмаги', aliases: ['Костко', 'Костка', 'Кост ко', 'Костко Холсейл'] },
  { name: 'Walmart', group: 'Продукты и универмаги', aliases: ['Волмарт', 'Вол март', 'Уолмарт', 'Валмарт', 'Уолл март'] },
  { name: 'Target', group: 'Продукты и универмаги', aliases: ['Таргет', 'Тарджет'] },
  { name: 'WinCo Foods', group: 'Продукты и универмаги', aliases: ['Винко', 'Винко Фудс', 'Винка', 'Винка Фуд', 'Винко Фуд', 'WinCo'] },
  { name: 'Safeway', group: 'Продукты и универмаги', aliases: ['Сейфвей', 'Сэйфвей', 'Сейфвэй', 'Сейф вей'] },
  { name: 'Vons', group: 'Продукты и универмаги', aliases: ['Вонс', 'Вонз'] },
  { name: 'Ralphs', group: 'Продукты и универмаги', aliases: ['Ральфс', 'Ральфз', 'Рафс', 'Ральф'] },
  { name: 'Albertsons', group: 'Продукты и универмаги', aliases: ['Альбертсонс', 'Албертсонс', 'Альбертсон', 'Албертсон'] },
  { name: "Trader Joe's", group: 'Продукты и универмаги', aliases: ['Трейдер Джо', 'Трейдер Джоус', 'Тредер Джо', 'Трейдер Джос', 'Trader Joes'] },
  { name: 'Sprouts', group: 'Продукты и универмаги', aliases: ['Спраутс', 'Спраут', 'Sprouts Farmers Market'] },
  { name: 'Stater Bros.', group: 'Продукты и универмаги', aliases: ['Статер Брос', 'Статер Бразерс', 'Stater Bros', 'Stater Brothers'] },
  { name: 'H-E-B', group: 'Продукты и универмаги', aliases: ['Эйч Ай Би', 'Эйчиби', 'Эйч И Би', 'ХЕБ', 'Хэб', 'HEB', 'Эйч-И-Би'] },
  { name: 'Kroger', group: 'Продукты и универмаги', aliases: ['Кроугер', 'Крогер', 'Крогир'] },
  { name: 'Tom Thumb', group: 'Продукты и универмаги', aliases: ['Том Там', 'Том Тамб', 'Том Фам'] },
  { name: "Sam's Club", group: 'Продукты и универмаги', aliases: ['Сэмс Клаб', 'Самс Клаб', 'Сэмз Клаб', 'Sams Club'] },
  { name: 'Home Depot', group: 'Хозяйственные', aliases: ['Хоум Депо', 'Хоумдепо', 'Хом Депо', 'Хоум Депот', 'The Home Depot'] },
  { name: "Lowe's", group: 'Хозяйственные', aliases: ['Лоус', 'Лоуз', 'Лоуес', 'Lowes'] },
  { name: 'Ace Hardware', group: 'Хозяйственные', aliases: ['Эйс Хардвер', 'Эйс Хардвэр', 'Эйс', 'Ace'] },
  { name: 'Harbor Freight', group: 'Хозяйственные', aliases: ['Харбор Фрейт', 'Харбор Фрэйт', 'Харбор Фрейд', 'Harbor Freight Tools'] },
];

// ---------- сравнение «по звучанию» ----------
const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'u', я: 'a' };

// Приводим кириллицу и латиницу к общему «звучанию»: Костко и Costco дают одно и то же kostko
export function phon(s) {
  let t = String(s).toLowerCase();
  t = [...t].map((ch) => CYR[ch] ?? ch).join('');
  t = t.replace(/[^a-z0-9]/g, '');
  t = t.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
    .replace(/w/g, 'v').replace(/y/g, 'i').replace(/q/g, 'k').replace(/x/g, 'ks');
  return t.replace(/(.)\1+/g, '$1');
}

export function distance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

const lc = (s) => String(s).trim().toLowerCase().replace(/ё/g, 'е');

// entries: [{ name, aliases: [], source: 'catalog' | 'custom' | 'list' }]
// Возвращает { name, source, how } или null, если похожего магазина нет (тогда создаётся новый).
export function resolveStore(input, entries) {
  const q = lc(input);
  if (!q) return null;
  // 1. совпадение названия или известного написания
  for (const e of entries) if (lc(e.name) === q) return { name: e.name, source: e.source, how: 'exact' };
  for (const e of entries) if ((e.aliases ?? []).some((a) => lc(a) === q)) return { name: e.name, source: e.source, how: 'alias' };
  // 2. то же по звучанию и похожее по звучанию (опечатки, другой выговор)
  const pq = phon(input);
  if (pq.length < 3) return null;
  let best = null, tie = false;
  for (const e of entries) {
    for (const cand of [e.name, ...(e.aliases ?? [])]) {
      const pc = phon(cand);
      if (pc.length < 3) continue;
      const d = distance(pq, pc);
      const limit = Math.max(0, Math.floor(Math.max(pq.length, pc.length) * 0.22));
      if (d > limit) continue;
      if (!best || d < best.d) { best = { d, e }; tie = false; }
      else if (d === best.d && best.e.name !== e.name) tie = true;
    }
  }
  if (!best || tie) return null; // не уверены: лучше создать новый список, чем смешать разные магазины
  return { name: best.e.name, source: best.e.source, how: best.d === 0 ? 'sound' : 'fuzzy' };
}

// Собираем всё, что известно о магазинах человека: готовый перечень, его выбор и свои магазины, существующие списки покупок
export function buildEntries(rows, listNames) {
  const byName = new Map();
  const add = (name, aliases, source) => {
    const k = lc(name);
    const cur = byName.get(k);
    if (cur) { cur.aliases = [...new Set([...cur.aliases, ...aliases])]; return; }
    byName.set(k, { name, aliases: [...aliases], source });
  };
  const learned = new Map(rows.map((r) => [lc(r.name), r]));
  for (const c of CATALOG) add(c.name, [...c.aliases, ...(learned.get(lc(c.name))?.aliases ?? [])], 'catalog');
  for (const r of rows) if (r.custom) add(r.name, r.aliases, 'custom');
  for (const n of listNames) add(n, [], 'list');
  return [...byName.values()];
}

export const MAX_ALIASES = 12;
