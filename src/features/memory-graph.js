// 记忆中枢的星图算法：亮度、区域、建边、布局。全部是纯函数，方便单测。
// 只读内置 memory 的条目，不保存正文，星图本身不是第二套记忆库。

const DAY = 86_400_000;
const GOLDEN = 2.399963229728653;
export const LAYOUT_VERSION = 7;
export const FADING_ID = 'fading';
export const FADING_LABEL = '快忘了';
export const FADING_THRESHOLD = 0.35;
// 清晰度低于阈值的长期记忆会被内置整理归档，统一放在星图上方的「归档星云」。
export const ARCHIVED_ID = 'archived';
export const ARCHIVED_LABEL = '归档星云';
// 「经历」是内置 memory 给事件记忆打的第一个标签。事件按 about 再分两类：
// 有 about 的是和这个人一起的经历（主人画画/唱歌），没 about 的是自己的经历（刷B站/抖音）。
// 团内的二级标签（B站、画画、唱歌……）作为子模块在面板里展开。
export const EVENT_ROOT_ID = 'tag:经历';
const EVENT_ROOT_LABEL = '自己的经历';
const EVENT_ROOT_TAG = '经历';
const EXPERIENCE_PREFIX = 'exp:';
const TYPE_ORDER = ['person', 'event', 'core', 'knowledge', 'outdated', 'archived'];
const clamp = (n, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(n)) ? Number(n) : min));
const round3 = (n) => { const r = Math.round(n * 1000) / 1000; return Object.is(r, -0) ? 0 : r; };

const timeOf = (value, fallback = 0) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : fallback;
};

/** 迁移用：和内置 memory.js 当前的 tau 公式保持一致，上线当天亮度不变。 */
export function initialStability(item) {
  const hitDays = Math.min(10, Math.max(0, Number(item.hitDays) || 0));
  const importance = clamp(item.importance ?? 0.5, 0, 1);
  return 20 * (1 + hitDays) * (0.5 + importance);
}

/** 艾宾浩斯保留率 R 和显示亮度 b。 */
export function brightness(star, item, now = Date.now()) {
  const last = timeOf(star?.lastHit, 0) || timeOf(item?.lastHit, 0) || timeOf(item?.at, now);
  const age = Math.max(0, (now - last) / DAY);
  const S = Math.max(1, Number(star?.S) || initialStability(item || {}));
  const retention = Math.exp(-age / S);
  const importance = clamp(item?.importance ?? 0.5, 0, 1);
  return clamp(retention * (0.6 + 0.4 * importance), 0, 1);
}

export function regionOf(item) {
  if (item?.archivedAt) return 'archived';
  if (item?.invalidAt) return 'outdated';
  if (item?.source === 'event') return 'event';
  if (item?.about) return 'person';
  if ((Number(item?.importance) || 0) >= 0.8) return 'core';
  return 'knowledge';
}

export function grams(text) {
  const s = String(text || '').replace(/[^\p{L}\p{N}]+/gu, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  if (!out.size && s) out.add(s);
  return out;
}

export function similarity(a, b) {
  const A = a instanceof Set ? a : grams(a);
  const B = b instanceof Set ? b : grams(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared += 1;
  return shared / (A.size + B.size - shared);
}

/**
 * 只按「同人物 / 同标签 / 高相似 / 被取代」建边，每颗星最多 5 条。
 * 不做全量两两比较，避免 3000 条时变成一坨毛球。
 */
export function buildEdges(items, perStar = 5) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const pairs = new Map();
  const add = (a, b, kind, weight) => {
    if (!a || !b || a === b) return;
    const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    const cur = pairs.get(key);
    if (!cur || cur.weight < weight) pairs.set(key, { a, b, kind, weight });
  };

  const BUCKET_LIMIT = 80;

  // 桶先收集全部成员，建边时再按等间距抽样到 BUCKET_LIMIT 条。
  // 直接截前 80 条会让大人物/大标签的后半段记忆永远没有边。
  const sampleBucket = (ids) => {
    if (ids.length <= BUCKET_LIMIT) return ids;
    const step = (ids.length - 1) / (BUCKET_LIMIT - 1);
    const sampled = [];
    for (let i = 0; i < BUCKET_LIMIT; i += 1) sampled.push(ids[Math.round(i * step)]);
    return sampled;
  };

  const buckets = new Map();
  const push = (key, id) => {
    if (!key) return;
    let set = buckets.get(key);
    if (!set) { set = new Set(); buckets.set(key, set); }
    set.add(id);
  };
  const text = new Map();
  for (const it of items) {
    if (!it || !it.id || it.invalidAt || it.archivedAt) continue;
    text.set(it.id, grams(it.text));
    if (it.about) push(`p:${it.about}`, it.id);
    for (const tag of Array.isArray(it.tags) ? it.tags.slice(0, 3) : []) push(`t:${tag}`, it.id);
  }

  for (const [key, members] of buckets) {
    const ids = sampleBucket([...members]);
    const kind = key.startsWith('p:') ? 'person' : 'tag';
    const base = kind === 'person' ? 0.5 : 0.4;
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) add(ids[i], ids[j], kind, base);
    }
  }

  // 相似度只算一次：以前这段放在桶循环里，同一对星同属 N 个桶就被算 N 次
  // （实测真实数据有一对被算了 4 遍，整体 13% 是重复计算）。
  // 现在先把所有「同桶候选对」收集进集合去重，再统一算一次相似度。
  const simPairs = new Set();
  const simKey = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  for (const [, members] of buckets) {
    const ids = sampleBucket([...members]);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) simPairs.add(simKey(ids[i], ids[j]));
    }
  }
  for (const key of simPairs) {
    const sep = key.indexOf('\u0000');
    const a = key.slice(0, sep);
    const b = key.slice(sep + 1);
    if (similarity(text.get(a), text.get(b)) >= 0.35) add(a, b, 'similar', 0.6);
  }

  for (const it of items) {
    if (it?.supersededBy && byId.has(it.supersededBy)) add(it.id, it.supersededBy, 'conflict', 1);
  }

  const ranked = [...pairs.values()].sort((x, y) => y.weight - x.weight);
  const count = new Map();
  const out = [];
  for (const edge of ranked) {
    if ((count.get(edge.a) || 0) >= perStar || (count.get(edge.b) || 0) >= perStar) continue;
    out.push(edge);
    count.set(edge.a, (count.get(edge.a) || 0) + 1);
    count.set(edge.b, (count.get(edge.b) || 0) + 1);
  }
  return out;
}

const tagsOf = (item) => (Array.isArray(item?.tags) ? item.tags.map((tag) => String(tag || '').trim().slice(0, 18)).filter(Boolean) : []);

// 来源 → 顶层模块。新功能（比如以后的「任务」）只要按约定写入一级标签，
// 或者在这张表里补一行来源映射，就会自动成为一个父团，不需要改布局代码。
const SOURCE_ROOT = {
  event: { id: EVENT_ROOT_ID, label: EVENT_ROOT_LABEL },
  diary: { id: 'tag:空间日记', label: '空间日记' },
};

/** 历史布局可能把父团拆成 `父id|tag:子标签` 或 `父id|time:2024Q1`，这里折回父团。 */
const legacyParentOf = (id) => {
  const text = String(id || '');
  const cut = text.indexOf('|');
  return cut > 0 ? text.slice(0, cut) : text;
};

/** 父团 id 对应的默认标签；人物名要用记忆里的名字，等 refreshLabel 修正。 */
const groupLabelOf = (id) => {
  if (id === FADING_ID) return FADING_LABEL;
  if (id === EVENT_ROOT_ID) return EVENT_ROOT_LABEL;
  if (id === ARCHIVED_ID) return ARCHIVED_LABEL;
  if (id === 'misc') return '杂项';
  if (id.startsWith(EXPERIENCE_PREFIX)) return '和人一起的经历';
  if (id.startsWith('tag:')) return id.slice(4, 16) || '杂项';
  if (id.startsWith('person:')) return '人物';
  return '杂项';
};

const parentTagOf = (groupId) => {
  const text = String(groupId || '');
  return text.startsWith('tag:') ? text.slice(4).split('|')[0] : '';
};

/** 星团里的小模块：跳过父标签和「经历」，取第一个剩下的标签。 */
const moduleTagOf = (item, parentTag) => tagsOf(item).slice(0, 3)
  .find((tag) => tag !== EVENT_ROOT_TAG && tag !== parentTag) || '未标注';

// 批量导入的 B站 记忆时间几乎全落在同一天，按时间分段没有意义；
// 这里按标题/正文里的高频主题分成几个内容星区，让大模块在空间上真的能分开。
const CONTENT_RULES = [
  ['美食', /米饭|奶茶|咖啡|蛋包饭|甜品|面包|电饭煲|焖饭|蛋炒饭|好吃|吃|厨|饭|锅|食谱|零食|水果|外卖/],
  ['游戏', /三角洲|LPL|CF|赛季|刀皮|枪|玩家|游戏|副本|攻略|地图|干员|皮肤|S12|赛事|战队|电竞|暗区/],
  ['萌宠', /猫|狗|鱼|白鲸|宠物|喵|汪|崽/],
];
const contentBucketOf = (item) => {
  const text = String(item?.text || '');
  for (const [label, re] of CONTENT_RULES) if (re.test(text)) return label;
  return '其他';
};

const fillRadiusOf = (size) => (size <= 1 ? 0 : 8 + Math.cbrt(size) * 13);

/**
 * 大团内部的视觉子星云。只对真的会挤成一团的大模块拆分：
 * 主导模块超过 60 条时，按内容星区分开；其余小模块保持自己的小星云。
 * 这只是空间分组，不改变父团归属，也不影响面板原有的标签筛选。
 */
const buildVisualChildren = (group, itemsById) => {
  const children = [];
  const childOf = new Map();
  if (group.size < 80) return { children, childOf, radius: 0 };

  const parentTag = parentTagOf(group.id);
  const modules = new Map();
  for (const id of group.ids) {
    const item = itemsById.get(id);
    if (!item) continue;
    const label = moduleTagOf(item, parentTag);
    modules.set(label, (modules.get(label) || 0) + 1);
  }
  const dominant = [...modules.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  // 只有 B站 这种内容型大模块才继续按主题拆；人物等模块保持原来的子模块。
  const splitContent = Boolean(dominant && dominant[0] === 'B站' && dominant[1] >= 60);

  const buckets = new Map();
  for (const id of group.ids) {
    const item = itemsById.get(id);
    if (!item) continue;
    const module = moduleTagOf(item, parentTag);
    const bucket = splitContent && module === dominant[0] ? contentBucketOf(item) : '';
    const label = bucket ? `${module}·${bucket}` : module;
    const entry = buckets.get(label) || { label, ids: [] };
    entry.ids.push(id);
    buckets.set(label, entry);
  }
  if (buckets.size < 2) return { children, childOf, radius: 0 };

  const base = fillRadiusOf(group.size);
  const discRadius = base * 0.74;
  const entries = [...buckets.values()].sort((a, b) => b.ids.length - a.ids.length || (a.label < b.label ? -1 : 1));
  for (const entry of entries) {
    entry.r = Math.round(clamp(4 + Math.cbrt(entry.ids.length) * 7.2, 10, base * 0.38) * 1000) / 1000;
  }

  // 子星云铺在一个微微倾斜的盘面上（像小星系），先按黄金角螺旋落位，
  // 再做几轮气泡松弛，保证相邻子星云的边缘不叠在一起。
  const TILT = 0.42;
  entries.forEach((entry, index) => {
    const t = (index + 0.5) / entries.length;
    const angle = index * GOLDEN + 0.7;
    const orbit = discRadius * Math.sqrt(t);
    const px = Math.cos(angle) * orbit;
    const pz = Math.sin(angle) * orbit;
    const py = (index % 2 ? 1 : -1) * base * 0.08;
    entry.x = px;
    entry.y = py * Math.cos(TILT) - pz * Math.sin(TILT);
    entry.z = py * Math.sin(TILT) + pz * Math.cos(TILT);
  });
  for (let pass = 0; pass < 10; pass += 1) {
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const a = entries[i];
        const b = entries[j];
        const dx = b.x - a.x; const dy = b.y - a.y; const dz = b.z - a.z;
        const distance = Math.hypot(dx, dy, dz);
        const min = a.r + b.r + 6;
        if (distance >= min) continue;
        const ux = distance < 1e-3 ? 1 : dx / distance;
        const uy = distance < 1e-3 ? 0.3 : dy / distance;
        const uz = distance < 1e-3 ? 0 : dz / distance;
        const push = (min - Math.max(distance, 1e-3)) / 2;
        a.x -= ux * push; a.y -= uy * push; a.z -= uz * push;
        b.x += ux * push; b.y += uy * push; b.z += uz * push;
      }
    }
  }
  // 不再把子星云缩回旧半径，而是按实际占用把父团光环撑大，
  // 这样拆出来的子星云之间始终有空隙，父团也能完整包住它们。
  let reach = 0;
  for (const entry of entries) reach = Math.max(reach, Math.hypot(entry.x, entry.y, entry.z) + entry.r);
  const parentRadius = Math.max(base, reach * 1.04);
  for (const entry of entries) {
    children.push({
      id: `${group.id}|child:${entry.label}`,
      label: entry.label,
      total: entry.ids.length,
      x: entry.x, y: entry.y, z: entry.z,
      r: entry.r,
    });
    for (const id of entry.ids) childOf.set(id, children[children.length - 1].id);
  }
  return { children, childOf, radius: parentRadius };
};

/** 所有父团都按次标签汇总子模块，和面板展开、筛选用的是同一套规则。 */
const childModulesOf = (group, itemsById) => {
  const counts = new Map();
  const parentTag = parentTagOf(group.id);
  for (const id of group.ids) {
    const item = itemsById.get(id);
    if (!item) continue;
    const label = moduleTagOf(item, parentTag);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const modules = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([label, count]) => ({ label, count }));
  // 全团只有一类（或全是未标注）时不算有子结构，避免点开只看到一个多余的标签。
  return modules.length > 1 ? modules : [];
};

/** 事件记忆的归属：有 about 的是和这个人的经历，没有 about 的是自己的经历。 */
const experienceAffiliationOf = (item) => {
  const about = String(item?.about || '').trim();
  if (!about) return { id: EVENT_ROOT_ID, label: EVENT_ROOT_LABEL, fixedLabel: true };
  const name = String(item?.aboutName || about).trim().slice(0, 12) || '某人';
  return { id: `${EXPERIENCE_PREFIX}${about}`, label: `和${name}的经历`, fixedLabel: true };
};

/** 主归属：事件先按经历拆分，其余人物优先，再其次来源定义的顶层模块，最后第一个标签。 */
const affiliationOf = (item) => {
  if (item?.archivedAt || item?.invalidAt) return { id: ARCHIVED_ID, label: ARCHIVED_LABEL, fixedLabel: true };
  if (item?.source === 'event') return experienceAffiliationOf(item);
  const raw = String(item?.about || '').trim();
  const name = String(item?.aboutName || raw).trim();
  if (raw) return { id: `person:${raw}`, label: name.slice(0, 12) || '人物' };
  const root = SOURCE_ROOT[item?.source];
  if (root) return { id: root.id, label: root.label };
  const tags = tagsOf(item);
  if (tags.length) return { id: `tag:${tags[0]}`, label: tags[0].slice(0, 12) };
  return { id: 'misc', label: '杂项' };
};

/** 增量同步时算这颗星该回哪个父团：事件按经历拆分，人物跟着人走，其余折回旧父团。 */
const canonicalHomeOf = (item, oldId) => {
  if (item?.archivedAt || item?.invalidAt) return ARCHIVED_ID;
  if (oldId === FADING_ID) return FADING_ID;
  if (item?.source === 'event') return experienceAffiliationOf(item).id;
  const about = String(item?.about || '').trim();
  if (about) {
    const parent = legacyParentOf(oldId);
    return parent.startsWith('person:') ? parent : `person:${about}`;
  }
  const root = SOURCE_ROOT[item?.source];
  if (root) return root.id;
  const parent = legacyParentOf(oldId);
  if (!parent || parent === ARCHIVED_ID) return affiliationOf(item).id;
  return parent.startsWith('person:') ? affiliationOf(item).id : parent;
};

/** 增量分组时用团里的记忆反推「和某某的经历」标签。 */
const experienceLabelOf = (id, itemsById, ids) => {
  const about = id.slice(EXPERIENCE_PREFIX.length);
  const item = ids.map((starId) => itemsById.get(starId)).find(Boolean);
  const name = String(item?.aboutName || about).trim().slice(0, 12) || '某人';
  return `和${name}的经历`;
};

const emptyGroup = (id, label, fixedLabel = false) => ({
  id, label, ids: [], size: 0, sumImp: 0, sumFresh: 0, types: {}, tags: {}, fixedLabel,
});

const addToGroup = (group, item, now) => {
  group.ids.push(item.id);
  group.size += 1;
  group.sumImp += clamp(item.importance ?? 0.5, 0, 1);
  group.sumFresh += brightness(undefined, item, now);
  const region = regionOf(item);
  group.types[region] = (group.types[region] || 0) + 1;
  for (const tag of tagsOf(item).slice(0, 3)) group.tags[tag] = (group.tags[tag] || 0) + 1;
};

const makeGroup = (id, label, ids, itemsById, now, fixedLabel = false) => {
  const group = emptyGroup(id, label, fixedLabel);
  for (const starId of ids) {
    const item = itemsById.get(starId);
    if (item) addToGroup(group, item, now);
  }
  return group;
};

const absorb = (target, small) => {
  for (const id of small.ids) target.ids.push(id);
  target.size += small.size;
  target.sumImp += small.sumImp;
  target.sumFresh += small.sumFresh;
  for (const [key, value] of Object.entries(small.types)) target.types[key] = (target.types[key] || 0) + value;
  for (const [key, value] of Object.entries(small.tags)) target.tags[key] = (target.tags[key] || 0) + value;
};

const mainTypeOf = (types) => TYPE_ORDER
  .map((key) => [key, Number(types?.[key]) || 0])
  .filter(([, count]) => count > 0)
  .sort((a, b) => b[1] - a[1] || TYPE_ORDER.indexOf(a[0]) - TYPE_ORDER.indexOf(b[0]))[0]?.[0] || 'knowledge';

const topTagsOf = (tags) => Object.entries(tags || {})
  .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  .slice(0, 3)
  .map(([tag]) => tag);

/** 合并后如果有大量不同主归属混在一起，就不再用某个人的名字充当整团标签。 */
const refreshLabel = (group, itemsById) => {
  if (group.fixedLabel || group.size <= 1) return;
  const counts = new Map();
  for (const id of group.ids) {
    const item = itemsById.get(id);
    if (!item) continue;
    const label = affiliationOf(item).label;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  let top = '';
  let topCount = 0;
  for (const [label, count] of counts) if (count > topCount || (count === topCount && label < top)) { top = label; topCount = count; }
  if (top && topCount / group.size >= 0.45) { group.label = top; return; }
  const tag = topTagsOf(group.tags)[0];
  if (tag && (group.tags[tag] || 0) / group.size >= 0.25) { group.label = tag; return; }
  group.label = mainTypeOf(group.types) === 'outdated' ? '归档' : '杂项';
};

/** 3D 星团布局：先按主归属聚团，再按评分自适应合并，最后稳定落点。 */
export function layoutGraph3d(items, options = {}) {
  const opts = options || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const prev = opts.prev && typeof opts.prev === 'object' ? opts.prev : null;
  const edges = Array.isArray(opts.edges) ? opts.edges : [];
  const list = Array.isArray(items) ? items.filter((item) => item?.id) : [];
  const itemsById = new Map(list.map((item) => [item.id, item]));
  const fadingSource = opts.fadingIds;
  const fadingIds = new Set(
    fadingSource instanceof Set || Array.isArray(fadingSource)
      ? [...fadingSource]
      : list.filter((item) => !item.invalidAt && !item.archivedAt && brightness(undefined, item, now) < FADING_THRESHOLD).map((item) => item.id),
  );
  const isFading = (item) => !item.invalidAt && !item.archivedAt && fadingIds.has(item.id);
  const total = list.length;
  const maxGroups = clamp(Math.round(8 + Math.sqrt(total) / 2.5), 8, 48);
  const minSize = clamp(Math.round(total / 250), 1, 6);
  const prevGroups = new Map((Array.isArray(prev?.groups) ? prev.groups : []).map((group) => [group.id, group]));
  // 布局算法升级后不再沿用旧坐标，但分组和子团迁移仍然参考旧的 clusters，
  // 这样升级只重排一次位置，历史归属不会丢。
  const reusePositions = prev?.version === LAYOUT_VERSION;
  const prevPositions = reusePositions && prev?.positions && typeof prev.positions === 'object' ? prev.positions : {};
  const prevClusters = prev?.clusters && typeof prev.clusters === 'object' ? prev.clusters : {};
  const prevChildOf = reusePositions && prev?.childOf && typeof prev.childOf === 'object' ? prev.childOf : {};
  const incremental = prevGroups.size > 0 && Object.keys(prevClusters).length > 0;

  // 1. 建组：首次布局按主归属建组；增量同步沿用旧星团，只给新星找归属。
  const groups = new Map();
  const groupOf = new Map();
  if (incremental) {
    const buckets = new Map();
    const bucketHome = new Map();
    for (const item of list) {
      const oldId = prevClusters[item.id];
      if (!oldId || !prevGroups.has(oldId)) continue;
      // 亮度跨过快忘阈值时重新归组：暗星进「快忘了」，复习变亮的星回原星团。
      if ((oldId === FADING_ID) !== isFading(item)) continue;
      // 历史子团（父id|tag:x）统一并回父团；事件按「和谁」拆成经历团，人物仍然按人物成团。
      const home = canonicalHomeOf(item, oldId);
      const bucket = buckets.get(home) || [];
      bucket.push(item.id);
      buckets.set(home, bucket);
      bucketHome.set(item.id, home);
    }
    for (const [id, ids] of buckets) {
      const old = prevGroups.get(id);
      // 老父团沿用自己的标签；新合并出来的父团用默认名，稍后 refreshLabel 会用记忆里的名字修正。
      const oldLabel = old?.label && !String(old.id).includes('|') && id !== EVENT_ROOT_ID ? old.label : '';
      const fixed = id === FADING_ID || id === ARCHIVED_ID || id === EVENT_ROOT_ID || id.startsWith(EXPERIENCE_PREFIX);
      const label = id === FADING_ID
        ? FADING_LABEL
        : oldLabel || (id.startsWith(EXPERIENCE_PREFIX) ? experienceLabelOf(id, itemsById, ids) : groupLabelOf(id));
      groups.set(id, makeGroup(id, label, ids, itemsById, now, fixed));
    }

    // 新星优先落进同主归属的旧团，哪怕这个人的旧团之前被合并过。
    const affCounts = new Map();
    for (const item of list) {
      const home = bucketHome.get(item.id);
      if (!home || home === FADING_ID || !groups.has(home)) continue;
      const aff = affiliationOf(item).id;
      let counts = affCounts.get(aff);
      if (!counts) { counts = new Map(); affCounts.set(aff, counts); }
      counts.set(home, (counts.get(home) || 0) + 1);
    }
    for (const item of list) {
      // 已经在 bucket 里加过、也登记过归属的星，直接沿用，不能再 add 一遍。
      const home = bucketHome.get(item.id);
      if (home) {
        groupOf.set(item.id, home);
        continue;
      }
      if (isFading(item)) {
        let group = groups.get(FADING_ID);
        if (!group) {
          group = emptyGroup(FADING_ID, FADING_LABEL, true);
          groups.set(FADING_ID, group);
        }
        addToGroup(group, item, now);
        groupOf.set(item.id, FADING_ID);
        continue;
      }
      const aff = affiliationOf(item);
      // affCounts 按主归属记录人数：person:u2 → { 某个旧团 id: 人数 }。
      // 旧团可能已被合并成别的 id，所以要取这个人最多的旧团，不能拿归属 id 当团 id 去查。
      let target = '';
      let bestCount = 0;
      const counts = affCounts.get(aff.id);
      if (counts) {
        for (const [gid, n] of counts) {
          if (n > bestCount || (n === bestCount && n > 0 && (!target || gid < target))) {
            bestCount = n;
            target = gid;
          }
        }
      }
      if (!target && groups.has(aff.id)) target = aff.id;
      if (target) {
        addToGroup(groups.get(target), item, now);
        groupOf.set(item.id, target);
      } else {
        const group = emptyGroup(aff.id, aff.label, Boolean(aff.fixedLabel));
        addToGroup(group, item, now);
        groups.set(aff.id, group);
        groupOf.set(item.id, aff.id);
      }
    }
  } else {
    for (const item of list) {
      if (isFading(item)) {
        let fading = groups.get(FADING_ID);
        if (!fading) {
          fading = emptyGroup(FADING_ID, FADING_LABEL, true);
          groups.set(FADING_ID, fading);
        }
        addToGroup(fading, item, now);
        groupOf.set(item.id, FADING_ID);
        continue;
      }
      const aff = affiliationOf(item);
      let group = groups.get(aff.id);
      if (!group) {
        group = emptyGroup(aff.id, aff.label, Boolean(aff.fixedLabel));
        groups.set(aff.id, group);
      }
      addToGroup(group, item, now);
      groupOf.set(item.id, group.id);
    }
  }

  const pairKey = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  const cross = new Map();
  const bump = (a, b, weight) => {
    if (!a || !b || a === b || !weight) return;
    const key = pairKey(a, b);
    cross.set(key, (cross.get(key) || 0) + weight);
  };
  for (const edge of edges) {
    const a = groupOf.get(edge.a);
    const b = groupOf.get(edge.b);
    if (a && b) bump(a, b, Number(edge.weight) || 0.1);
  }

  // 2. 小组合并：初次布局还要把总团数收进 maxGroups；增量布局只合并极小的团，保持旧星稳定。
  let guard = 0;
  while (groups.size > 1 && guard < total + 8) {
    guard += 1;
    let smallest = null;
    for (const group of groups.values()) {
      if (group.id === FADING_ID || group.id === ARCHIVED_ID || group.id === EVENT_ROOT_ID) continue;
      const mergeSmall = group.size < minSize;
      const mergeMany = !incremental && groups.size > maxGroups;
      if (!mergeSmall && !mergeMany) continue;
      if (!smallest || group.size < smallest.size || (group.size === smallest.size && group.id < smallest.id)) smallest = group;
    }
    if (!smallest) break;

    let target = null;
    let bestWeight = -1;
    for (const other of groups.values()) {
      if (other === smallest || other.id === FADING_ID || other.id === ARCHIVED_ID || other.id === EVENT_ROOT_ID) continue;
      const weight = cross.get(pairKey(smallest.id, other.id)) || 0;
      if (weight > bestWeight || (weight === bestWeight && target && other.size > target.size)) {
        bestWeight = weight;
        target = other;
      }
    }
    if (!target) break;

    absorb(target, smallest);
    for (const id of smallest.ids) groupOf.set(id, target.id);
    for (const other of groups.values()) {
      if (other === target || other === smallest) continue;
      bump(target.id, other.id, cross.get(pairKey(smallest.id, other.id)) || 0);
    }
    groups.delete(smallest.id);
  }

  for (const group of groups.values()) refreshLabel(group, itemsById);

  // 3. 父团不再拆成 `X · #y` 小团：超过再大也保持一个团，内部按次标签生成子模块，
  //    点星团后在面板里展开，这样模块数量不会随记忆增长而爆炸。
  const finalGroups = [...groups.values()];

  // 4. 统计、评分与子模块。评分 = 规模 × 平均重要度 × 新鲜度 × 连接度。
  const finalGroupOf = new Map();
  for (const group of finalGroups) for (const id of group.ids) finalGroupOf.set(id, group.id);
  const internal = new Map();
  for (const edge of edges) {
    const a = finalGroupOf.get(edge.a);
    const b = finalGroupOf.get(edge.b);
    if (a && a === b) internal.set(a, (internal.get(a) || 0) + 1);
  }
  for (const group of finalGroups) {
    refreshLabel(group, itemsById);
    group.avgImportance = group.size ? group.sumImp / group.size : 0;
    group.avgFreshness = group.size ? group.sumFresh / group.size : 0;
    group.connectivity = 1 + Math.min(4, (internal.get(group.id) || 0) / Math.max(1, group.size));
    group.score = group.size
      * (0.35 + 0.65 * group.avgImportance)
      * (0.35 + 0.65 * group.avgFreshness)
      * group.connectivity;
    group.mainType = mainTypeOf(group.types);
    group.topTags = topTagsOf(group.tags);
    group.children = group.id === ARCHIVED_ID ? [] : childModulesOf(group, itemsById);
    const visual = group.id === ARCHIVED_ID
      ? { children: [], childOf: new Map(), radius: 0 }
      : buildVisualChildren(group, itemsById);
    group.childClusters = visual.children;
    group.childOf = visual.childOf;
    // 拆出子星云的父团需要更大的光环，才能把子星云完整包住。
    group.fillR = Math.max(fillRadiusOf(group.size), Number(visual.radius) || 0);
  }

  const sorted = finalGroups.sort((a, b) => b.score - a.score || b.size - a.size || (a.id < b.id ? -1 : 1));

  // 5. 星团中心：先算一组确定的「理想位置」，再决定当前布局怎么走。
  //    首次布局直接落到理想位置；之后每次同步沿理想位置移动一小步（settle），
  //    星团慢慢散开，不会突然跳。团变多时轨道半径也会逐步放大。
  const fillRadius = (group) => group.fillR || fillRadiusOf(group.size);
  const radiusMass = Math.sqrt(sorted.reduce((sum, group) => sum + fillRadius(group) ** 2, 0));
  const maxRadius = Math.max(0, ...sorted.map((group) => fillRadius(group)));
  const targetOrbit = clamp(
    Math.max(300 + 160 * Math.sqrt(sorted.length / 10), radiusMass * 1.5 + maxRadius, 470),
    470,
    900,
  );
  const prevRadius = Number(prev?.radius) || 0;
  const settleRatio = clamp(Number(opts.settle) || 0, 0, 1);
  const orbit = !prev || !reusePositions
    ? targetOrbit
    : settleRatio > 0
      ? prevRadius + (targetOrbit - prevRadius) * settleRatio
      : (prevRadius > 100 ? prevRadius : targetOrbit);

  // 稳定顺序：大团先分槽位。亮度评分会让排序缓慢变化，这里不用它，
  // 避免同一批星团每轮理想位置都换地方。
  const stableOrder = [...sorted].sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1));

  // 球面候选点：黄金角螺旋 + 轻微压扁的 y 轴，保持前后和上下都有纵深。
  const CANDIDATES = 96;
  const slots = [];
  for (let i = 0; i < CANDIDATES; i += 1) {
    const gy = 1 - 2 * (i + 0.5) / CANDIDATES;
    const ring = Math.sqrt(Math.max(0, 1 - gy * gy));
    const angle = i * GOLDEN + 0.9;
    slots.push({
      x: Math.cos(angle) * ring * orbit,
      y: gy * orbit * 0.9,
      z: Math.sin(angle) * ring * orbit,
    });
  }

  const buildCenters = (base, onlyFreshMovable) => {
    const result = new Map();
    const placed = [];
    const fresh = [];
    for (const group of stableOrder) {
      // 「快忘了」固定在星图下方，「归档星云」固定在星图上方，都单独成块，方便一眼找到。
      if (group.id === FADING_ID || group.id === ARCHIVED_ID) {
        const y = group.id === FADING_ID ? -orbit * 1.08 : orbit * 1.08;
        const center = { x: 0, y, z: 0 };
        result.set(group.id, center);
        placed.push({ ...center, r: fillRadius(group) });
      }
    }
    for (const group of stableOrder) {
      if (group.id === FADING_ID || group.id === ARCHIVED_ID) continue;
      const from = base?.get(group.id);
      if (from) {
        result.set(group.id, { ...from });
        placed.push({ ...from, r: fillRadius(group) });
      } else {
        fresh.push(group);
      }
    }
    for (const group of fresh) {
      const radius = fillRadius(group);
      let best = slots[0];
      let bestClearance = -Infinity;
      for (const slot of slots) {
        let clearance = Infinity;
        for (const other of placed) {
          const gap = Math.hypot(slot.x - other.x, slot.y - other.y, slot.z - other.z) - radius - other.r;
          if (gap < clearance) clearance = gap;
        }
        if (clearance > bestClearance) {
          bestClearance = clearance;
          best = slot;
        }
      }
      const center = { x: best.x, y: best.y, z: best.z };
      result.set(group.id, center);
      placed.push({ ...center, r: radius });
    }

    // 气泡式松弛：保证团中心距离大于两个团半径之和，光环不会压在一起。
    const movable = onlyFreshMovable
      ? new Set(fresh.map((group) => group.id))
      : new Set(stableOrder.filter((group) => group.id !== FADING_ID && group.id !== ARCHIVED_ID).map((group) => group.id));
    for (let pass = 0; pass < 10; pass += 1) {
      for (let i = 0; i < stableOrder.length; i += 1) {
        for (let j = i + 1; j < stableOrder.length; j += 1) {
          const a = stableOrder[i];
          const b = stableOrder[j];
          const ca = result.get(a.id);
          const cb = result.get(b.id);
          if (!ca || !cb) continue;
          const moveA = movable.has(a.id);
          const moveB = movable.has(b.id);
          if (!moveA && !moveB) continue;
          const dx = cb.x - ca.x;
          const dy = cb.y - ca.y;
          const dz = cb.z - ca.z;
          const distance = Math.hypot(dx, dy, dz);
          const minDistance = (fillRadius(a) + fillRadius(b)) * 1.12 + 22;
          if (distance >= minDistance) continue;
          let ux = dx;
          let uy = dy;
          let uz = dz;
          if (distance < 1e-3) {
            const angle = (i + j) * GOLDEN;
            ux = Math.cos(angle);
            uy = 0.35;
            uz = Math.sin(angle);
            const len = Math.hypot(ux, uy, uz);
            ux /= len; uy /= len; uz /= len;
          } else {
            ux /= distance; uy /= distance; uz /= distance;
          }
          const push = (minDistance - Math.max(distance, 1e-3)) / (moveA && moveB ? 2 : 1);
          if (moveA) { ca.x -= ux * push; ca.y -= uy * push; ca.z -= uz * push; }
          if (moveB) { cb.x += ux * push; cb.y += uy * push; cb.z += uz * push; }
        }
      }
    }
    return result;
  };

  const currentCenters = () => {
    const base = new Map();
    for (const group of stableOrder) {
      if (group.id === FADING_ID || group.id === ARCHIVED_ID) continue;
      const old = reusePositions ? prevGroups.get(group.id) : null;
      if (!old || ![old.x, old.y, old.z].every(Number.isFinite)) continue;
      const len = Math.hypot(old.x, old.y, old.z);
      if (len <= 1e-3) continue;
      const scale = prevRadius > 100 ? orbit / prevRadius : 1;
      base.set(group.id, { x: old.x * scale, y: old.y * scale, z: old.z * scale });
    }
    return base;
  };

  let centers;
  let settleInfo = { applied: false, maxMove: 0 };
  if (!prev || !reusePositions) {
    // 首次生成或从旧版布局升级：直接落到理想位置。
    centers = buildCenters(null, false);
    settleInfo = { applied: true, maxMove: orbit };
  } else if (settleRatio > 0) {
    const base = currentCenters();
    const ideal = buildCenters(null, false);
    // 新出现的团还没有旧位置，先按「当前已占位置」找一个不压光环的空位，
    // 不能直接跳到理想槽位——那个槽位可能还被慢慢挪走的老团占着。
    const freshOnly = buildCenters(base, true);
    centers = new Map();
    // 手动「立即优化」传 settle=1，直接落到理想位置；后台同步则每次只挪一小步。
    const maxStep = settleRatio >= 1 ? Infinity : Math.max(24, orbit * 0.12);
    let maxMove = 0;
    for (const group of stableOrder) {
      const target = ideal.get(group.id);
      if (!target) continue;
      const from = base.get(group.id);
      if (!from) {
        // 手动优化时全部团一起落位，直接用理想槽位；后台微调则先避开当前占位。
        const placed = settleRatio >= 1 ? target : (freshOnly.get(group.id) || target);
        centers.set(group.id, { ...placed });
        continue;
      }
      const dx = target.x - from.x;
      const dy = target.y - from.y;
      const dz = target.z - from.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance < 0.5) { centers.set(group.id, from); continue; }
      const step = Math.min(distance, maxStep, distance * settleRatio);
      const k = step / distance;
      centers.set(group.id, { x: from.x + dx * k, y: from.y + dy * k, z: from.z + dz * k });
      if (step > maxMove) maxMove = step;
    }
    settleInfo = { applied: true, maxMove };
  } else {
    // 普通增量：老团保持原位，只有新团挑空位，保证老星不乱跑。
    centers = buildCenters(currentCenters(), true);
  }

  // 6. 星点落位：老星保留原星团内的局部偏移，新星在团内确定性地散开。
  //    有视觉子星云时，星点先落到对应子星云里，而不是继续铺满整个父团。
  const positions = {};
  const clusters = {};
  const childOf = {};
  for (const group of sorted) {
    const center = centers.get(group.id);
    if (!center) continue;
    const visualChildren = group.childClusters || [];
    const childById = new Map(visualChildren.map((child) => [child.id, child]));
    const oldGroup = prevGroups.get(group.id);
    const oldChildById = new Map((oldGroup?.childClusters || []).map((child) => [child.id, child]));
    const reused = [];
    const freshByChild = new Map();
    for (const id of group.ids) {
      const oldGroupId = prevClusters[id];
      const oldPos = prevPositions[id];
      const oldCenter = oldGroupId ? prevGroups.get(oldGroupId) : null;
      const childId = group.childOf?.get(id) || '';
      const oldChildId = prevChildOf[id] || '';
      const reusable = oldGroupId === group.id && oldPos && oldCenter
        && [oldPos.x, oldPos.y, oldPos.z].every(Number.isFinite)
        && oldChildId === childId;
      if (reusable) {
        const child = childById.get(childId);
        const oldChild = oldChildById.get(oldChildId);
        // 子星云中心可能因为团大小变化挪了一点；星点要跟着自己的小星云走，
        // 否则会留在旧位置、跑到别的子模块里。
        const shiftX = child && oldChild ? child.x - oldChild.x : 0;
        const shiftY = child && oldChild ? child.y - oldChild.y : 0;
        const shiftZ = child && oldChild ? child.z - oldChild.z : 0;
        reused.push({
          id,
          x: oldPos.x - oldCenter.x + shiftX,
          y: oldPos.y - oldCenter.y + shiftY,
          z: oldPos.z - oldCenter.z + shiftZ,
        });
      } else {
        const list = freshByChild.get(childId) || [];
        list.push(id);
        freshByChild.set(childId, list);
      }
    }

    const base = fillRadius(group);
    const offsets = new Map(reused.map((offset) => [offset.id, offset]));
    for (const [childId, ids] of freshByChild) {
      const child = childById.get(childId);
      const origin = child || { x: 0, y: 0, z: 0 };
      const radius = child ? child.r : base;
      ids.sort((a, b) => {
        const ia = itemsById.get(a) || {};
        const ib = itemsById.get(b) || {};
        return (Number(ib.importance) || 0) - (Number(ia.importance) || 0) || (a < b ? -1 : 1);
      });
      ids.forEach((id, index) => {
        const count = ids.length;
        const t = count <= 1 ? 0.5 : (index + 0.5) / count;
        const rr = radius * Math.cbrt(t);
        const polar = Math.acos(clamp(1 - 2 * t, -1, 1));
        let angle = index * GOLDEN + 0.9 + ((group.id.length + childId.length) % 7) * 0.35;
        let offset = {
          id,
          x: origin.x + rr * Math.sin(polar) * Math.cos(angle),
          y: origin.y + rr * Math.cos(polar),
          z: origin.z + rr * Math.sin(polar) * Math.sin(angle),
        };
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const hit = reused.some((other) => Math.hypot(offset.x - other.x, offset.y - other.y, offset.z - other.z) < 3.5);
          if (!hit) break;
          angle += GOLDEN;
          offset = {
            id,
            x: origin.x + rr * Math.sin(polar) * Math.cos(angle),
            y: origin.y + rr * Math.cos(polar),
            z: origin.z + rr * Math.sin(polar) * Math.sin(angle),
          };
        }
        offsets.set(id, offset);
      });
    }

    let reach = base;
    for (const offset of offsets.values()) reach = Math.max(reach, Math.hypot(offset.x, offset.y, offset.z));
    group.r = round3(Math.max(base, reach * 1.04));
    for (const [id, offset] of offsets) {
      positions[id] = {
        x: Math.round(center.x + offset.x) || 0,
        y: Math.round(center.y + offset.y) || 0,
        z: Math.round(center.z + offset.z) || 0,
      };
      clusters[id] = group.id;
      if (group.childOf?.has(id)) childOf[id] = group.childOf.get(id);
    }
  }

  return {
    version: LAYOUT_VERSION,
    radius: round3(orbit),
    groups: sorted.map((group) => ({
      id: group.id,
      label: group.label,
      x: round3(centers.get(group.id)?.x || 0),
      y: round3(centers.get(group.id)?.y || 0),
      z: round3(centers.get(group.id)?.z || 0),
      r: group.r || 0,
      total: group.size,
      mainType: group.mainType,
      tags: group.topTags,
      children: group.children || [],
      // 父团内部的视觉子星云，坐标相对父团中心；只用于渲染和点入，不改变归属。
      childClusters: (group.childClusters || []).map((child) => ({
        id: child.id,
        label: child.label,
        total: child.total,
        x: round3(child.x),
        y: round3(child.y),
        z: round3(child.z),
        r: round3(child.r),
      })),
    })),
    clusters,
    positions,
    childOf,
    // 给模块层记录本轮位置调整量，便于日志观察自动优化有没有在动。
    settle: { applied: settleInfo.applied, maxMove: round3(settleInfo.maxMove) },
  };
}

export function brightnessLabel(value) {
  if (value >= 0.7) return '清晰';
  if (value >= FADING_THRESHOLD) return '有点模糊';
  if (value >= 0.05) return '快忘了';
  return '几乎想不起';
}

// ─────────────────────────────────────────────────────────────
// 和 Aurabot rc1 的档位对接（这一段是移植时新加的，上面全是原版算法）
//
// 记忆中枢原本对着 1.1.24 的 tier 值域 `short / long / core` 写的；
// rc1（1.2.0）的 tier 是数字 `0 / 1 / 2 / 3` 加上字符串 `'core'`。
//
// 语义对照（用户确认过）：
//   rc1 0     永久档      → 星图 core（永久）
//   rc1 1     琐碎/临时    → 星图 short（临时）
//   rc1 2     一般/长期    → 星图 long（长期）
//   rc1 3     重要        → 星图 core（永久）
//   rc1 'core' 长期印象    → 星图 core（永久）
//   rc1 undefined 未分档   → 星图 long（长期）——和中枢默认一致
// 反查（星图 → rc1 数字档，用于手动分层）：
//   short → 1，long → 2，core → 3
// ─────────────────────────────────────────────────────────────
export const TIER_TO_STAR = { 0: 'core', 1: 'short', 2: 'long', 3: 'core', core: 'core' };
export const STAR_TO_TIER = { short: 1, long: 2, core: 3 };
export const STAR_TIER_LABEL = { short: '临时', long: '长期', core: '永久' };

/** rc1 的 tier 值 → 星图用的 tier 标签。认不出来的统一按「长期」。 */
export function toStarTier(tier) {
  if (tier === undefined || tier === null) return 'long';
  const key = typeof tier === 'string' ? tier : Number(tier);
  return TIER_TO_STAR[key] || 'long';
}

/**
 * 星图的 tier 标签（short/long/core）→ rc1 的数字档（0~3）。
 * 认不出来的返回 null（调用方据此拒绝改档）。
 * 兼容直接传数字的情况（面板/导入有时手上已经是 0~3）。
 */
export function toHostTier(starTier) {
  if (Number.isInteger(starTier) && starTier >= 0 && starTier <= 3) return starTier
  const n = STAR_TO_TIER[String(starTier || '')]
  return Number.isInteger(n) ? n : null
}
