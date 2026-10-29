// Aurabot 桌宠「形象包元数据」纯函数（UMD：主进程 require / 渲染页 <script> / 单测 new Function 都能用）。
//
// 为什么单独成文件：/config 的 pack.animations 只给 idle / speak / click 三个池，
// 但右键「动作」菜单要列**包里所有**动画（default 包 106 段里只有 26 段在池里）。
// 客户端曾只按这三个池建素材地址表 → 菜单里另外 80 段点了完全没反应，
// 因为渲染页 __playAnim 查不到 URL 就 return false，桌宠继续播它自己的 idle。
// 现在统一由 knownAnims() 合并「池 ∪ 包目录里的 webm」，菜单与地址表用的是同一份名单。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.PetPackMeta = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  const POOL_KEYS = ['idle', 'speak', 'click']
  const POOL_TITLES = { idle: '待机', speak: '说话', click: '互动' }

  /** 'anim-001.webm' → 'anim-001' */
  const stripExt = (f) => String(f || '').replace(/\.webm$/i, '')

  /** 包目录里的文件名列表 → 动画名列表（只认 .webm，去重保序）。 */
  function namesFromFiles(files) {
    const out = []
    for (const f of files || []) {
      if (!/\.webm$/i.test(String(f || ''))) continue
      const n = stripExt(f)
      if (n && !out.includes(n)) out.push(n)
    }
    return out
  }

  /** 包里全部可点播动画 = 三个池 ∪ 目录里的 webm（池里的名字可能没有对应文件，也保留：渲染页会回落）。 */
  function knownAnims(pools, files) {
    const out = []
    const push = (n) => { const s = String(n || ''); if (s && !out.includes(s)) out.push(s) }
    for (const k of POOL_KEYS) for (const n of (pools && pools[k]) || []) push(n)
    for (const n of namesFromFiles(files)) push(n)
    return out
  }

  /** 动画名 → 素材地址表。makeUrl(name) 负责拼 baseUrl/api/token（主进程知道端口与 token）。 */
  function animUrlMap(names, makeUrl) {
    const map = {}
    for (const n of names || []) {
      const url = typeof makeUrl === 'function' ? makeUrl(n) : ''
      if (url) map[n] = url
    }
    return map
  }

  /** manifest（原名 → id）→ id → 原名（菜单显示中文用）。 */
  function labelsOf(manifest) {
    const labels = {}
    for (const [orig, id] of Object.entries(manifest || {})) if (typeof id === 'string' && id) labels[id] = orig
    return labels
  }

  /** 右键「动作」菜单树：[{ label, items:[{ label, id }] }]。
   *  优先包配置的 menu 段（10 个分类），没有就回落 idle/speak/click 三个池。 */
  function resolveMenu(cfg, manifest, pools) {
    const man = manifest && typeof manifest === 'object' ? manifest : {}
    const labels = labelsOf(man)
    // 配置里写「原名」或直接写「id」都认
    const idOf = (orig) => (man[orig] ? man[orig] : (labels[orig] ? orig : null))
    const cats = []
    if (cfg && Array.isArray(cfg.menu)) {
      for (const c of cfg.menu) {
        const items = []
        for (const orig of (c && c.anims) || []) {
          const id = idOf(orig)
          if (id) items.push({ label: String(orig), id })
        }
        if (items.length) cats.push({ label: String((c && c.label) || '其他'), items })
      }
    }
    if (!cats.length) {
      for (const k of POOL_KEYS) {
        const items = ((pools && pools[k]) || []).map((id) => ({ label: labels[id] || id, id }))
        if (items.length) cats.push({ label: POOL_TITLES[k], items })
      }
    }
    return cats
  }

  return { POOL_KEYS, POOL_TITLES, stripExt, namesFromFiles, knownAnims, animUrlMap, labelsOf, resolveMenu }
})
