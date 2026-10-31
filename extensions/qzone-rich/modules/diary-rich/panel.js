const { useState, useRef, useEffect } = React
const kinds = { sticker: '表情包', browsing: '浏览摘记', local: '日常图库', card: '手记卡', manual: '指定图片' }
return function DiaryRichPanel({ toast, reload }) {
  const [state, setState] = useState(null), [busy, setBusy] = useState(false), [folder, setFolder] = useState('')
  const current = useRef(null), pending = useRef(false), dirtyFolder = useRef(false), root = useRef(null), previewAction = useRef(null), headerButton = useRef(null)
  const load = async (force = false) => {
    try { const s = await call('/state'); if (!s.ok || pending.current && !force) return; current.current = s; setState(s); if (!dirtyFolder.current) setFolder(s.settings.folder || '') } catch {}
  }
  const act = async (path, body, message) => {
    if (pending.current || current.current?.busy) return
    pending.current = true; setBusy(true)
    try {
      const r = await fetch('/aurabot/api/ext/diary-rich' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aurabot-diary': '1' }, body: JSON.stringify(body || {}) }).then((r) => r.json())
      if (!r.ok) throw new Error(r.message || '这次没有完成')
      if (path === '/folder') dirtyFolder.current = false
      await load(true); reload?.(); toast(r.message || message || '已保存')
    } catch (error) { toast(error.message || '这次没有完成，请重试') }
    finally { pending.current = false; setBusy(false) }
  }
  const preview = () => { root.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return act('/preview', {}, '图文预览已生成，没有发布') }
  previewAction.current = preview
  useEffect(() => { load(); const timer = setInterval(load, 3000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    const heading = [...document.querySelectorAll('.ab-root .ab-card h3')].find((el) => el.textContent === '写过的日记')
    const controls = heading?.parentElement?.querySelector('div.ab-flex')
    const button = document.createElement('button'); button.type = 'button'; button.className = 'ab-btn sm'; button.dataset.aurabotDiaryPreview = '1'; button.textContent = '预览图文'
    const click = () => previewAction.current?.(); button.addEventListener('click', click); controls?.appendChild(button); headerButton.current = button
    const previousFetch = window.fetch; let alive = true
    const withCurrentSettings = (input, init) => {
      if (alive && current.current && typeof init?.body === 'string') {
        try { const u = new URL(typeof input === 'string' ? input : input.url, location.href); if (u.origin === location.origin && u.pathname === '/aurabot/api/save') { const cfg = JSON.parse(init.body); if (cfg.ext && typeof cfg.ext === 'object') { cfg.ext['diary-rich'] = { ...(cfg.ext['diary-rich'] || {}), ...current.current.settings }; init = { ...init, body: JSON.stringify(cfg) } } } } catch {}
      }
      return previousFetch.call(window, input, init)
    }
    window.fetch = withCurrentSettings
    return () => { button.removeEventListener('click', click); button.remove(); headerButton.current = null; alive = false; if (window.fetch === withCurrentSettings) window.fetch = previousFetch }
  }, [])
  useEffect(() => { if (headerButton.current) { headerButton.current.disabled = busy || state?.busy; headerButton.current.textContent = busy || state?.busy ? '正在写图文…' : '预览图文' } }, [busy, state?.busy])
  const gallery = (images) => h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 12 } }, ...(images || []).map((p) => h('div', { key: p.id, style: { width: 150, maxWidth: '100%' } },
    h('a', { href: p.src, target: '_blank', rel: 'noreferrer' }, h('img', { src: p.src, alt: p.caption || kinds[p.kind] || '日记配图', style: { width: '100%', height: 130, objectFit: 'contain', borderRadius: 10, background: 'var(--ab-card-2)' } })),
    h('div', { className: 'ab-small ab-muted', style: { overflowWrap: 'anywhere' } }, (kinds[p.kind] || '图片') + ' · ' + (p.caption || '')))))
  const toggle = (key, label) => h(ui.Row, { key, label }, h(ui.Switch, { on: !!state?.settings?.[key], disabled: busy, onChange: (value) => act('/settings', { [key]: value }) }))
  return h('div', { ref: root, 'data-diary-rich-panel': '1' },
    h(ui.Card, { title: '日记配图与预览', desc: '她会围绕最近的真实经历写日记，按内容选择表情、浏览图或日常图片；定时日记和「现在写一篇」都会使用这些设置。' },
      !state ? h('p', { className: 'ab-muted' }, '正在读取配图来源…') : h(React.Fragment, null,
        toggle('enabled', '自动搭配图片'), toggle('stickers', '使用表情库'), toggle('browsing', '使用最近浏览的配图'), toggle('local', '使用日常图片或截图'), toggle('cards', '可生成手记文字卡'),
        h(ui.Row, { label: '每篇最多配图' }, h('select', { className: 'ab-input', value: state.settings.maxImages, disabled: busy, 'aria-label': '每篇最多配图', onChange: (e) => act('/settings', { maxImages: Number(e.target.value) }) }, ...[1, 2, 3, 4].map((n) => h('option', { key: n, value: n }, n + ' 张')))),
        h(ui.Row, { label: '日常图片文件夹', hint: '可手动放图；自动收集会在日期子目录新增浏览图，不改已有图片。' }, h('input', { className: 'ab-input', 'aria-label': '日常图片文件夹', value: folder, disabled: busy, placeholder: '例如 H:\\日常图片', style: { flex: '1 1 220px', maxWidth: '100%', minWidth: 0 }, onChange: (e) => { dirtyFolder.current = true; setFolder(e.target.value) } }), h(ui.Btn, { small: true, disabled: busy, onClick: () => act('/folder', { folder }) }, '读取图片')),
        h('p', { className: 'ab-small ab-muted' }, `可用素材：${state.counts.stickers} 张表情 · ${state.counts.browsing} 张浏览图 · ${state.counts.local} 张日常图片 · ${state.counts.experiences} 条近期经历`),
        state.folderError ? h('p', { className: 'ab-note warn' }, state.folderError) : null,
        h(ui.Btn, { kind: 'primary', disabled: busy || state.busy, onClick: preview }, busy || state.busy ? '正在写图文…' : '预览图文，不发布'),
        h('p', { className: 'ab-small ab-muted' }, '浏览图会标注来源；日常截图从指定图库读取，不会自动截取桌面或聊天窗口。'))),
    state?.draft ? h(ui.Card, { title: '这次的图文预览', desc: '仅在面板里预览，没有发布到 QQ 空间。' }, h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, state.draft.text), gallery(state.draft.images), ...(state.draft.warnings || []).map((w, i) => h('p', { key: i, className: 'ab-small ab-muted' }, w))) : null,
    state?.history?.length ? h(ui.Card, { title: '最近的配图日记' }, ...state.history.map((d, i) => h('div', { key: d.tid || i, style: { marginTop: 16 } }, h('p', { className: 'ab-small ab-muted' }, new Date(d.at).toLocaleString() + ' · ' + (d.dryRun ? '试运行，未发布' : d.ok ? '已发布' : '未完成')), h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, d.text), gallery(d.images)))) : null)
}
