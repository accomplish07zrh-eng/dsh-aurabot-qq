// 微博模块面板（Aurabot 自定义面板）
// 执行环境提供：React / h / ui / call / settings / save / toast
const { useState, useEffect, useRef } = React

return function WeiboPanel ({ settings, save, toast }) {
  const [st, setSt] = useState(null)          // /state
  const [acc, setAcc] = useState(null)        // /account
  const [qr, setQr] = useState('')
  const [busy, setBusy] = useState('')
  const [showAdv, setShowAdv] = useState(false)
  const timer = useRef(null)

  const load = async () => {
    try {
      const s = await call('/state')
      if (s) { setSt(s); setAcc((s && s.account) || null) }
    } catch (e) { /* 忽略：面板还没准备好 */ }
  }

  useEffect(() => {
    load()
    timer.current = setInterval(load, 4000)
    return () => clearInterval(timer.current)
  }, [])

  const cfg = (st && st.config) || {}
  const counts = (st && st.counts) || {}
  const logged = Boolean(acc && acc.loggedIn)
  const preset = cfg.preset || 'normal'
  const danger = cfg.dryRun === false

  const [hint, setHint] = useState('')
  const doQr = async () => {
    setBusy('qr'); setQr(''); setHint('')
    try {
      const r = await call('/login/start')
      if (!r || !r.ok) { toast((r && r.message) || '启动登录失败'); setBusy(''); return }
      setHint(r.hint || '')
      if (r.image) setQr(r.image)
      toast(r.windowOpened ? '已打开微博登录窗口' : '二维码已生成，2 分钟内有效')
    } catch (e) { toast('启动登录失败：' + e.message) }
    setBusy('')
  }

  const doPreset = async (name) => {
    setBusy(name)
    try {
      const r = await call('/preset', { name })
      if (r && r.ok) { toast('已切换到该档位'); await load() } else toast((r && r.message) || '切换失败')
    } catch (e) { toast('切换失败：' + e.message) }
    setBusy('')
  }

  const doLogout = async () => {
    setBusy('logout')
    try {
      const r = await call('/logout')
      toast(r && r.ok ? '已退出登录' : '退出失败')
      setQr('')
      await load()
    } catch (e) { toast('退出失败：' + e.message) }
    setBusy('')
  }

  const set = (patch) => { save(patch); setTimeout(load, 400) }

  const badge = (on, onText, offText) => h('span', {
    className: 'ab-small',
    style: { padding: '2px 8px', borderRadius: 10, background: on ? '#e8f7ee' : '#fdecec', color: on ? '#1a7f45' : '#b3261e' },
  }, on ? onText : offText)

  const step = (n, text) => h('div', { className: 'ab-small', style: { margin: '4px 0' } }, `${n}. ${text}`)

  const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, margin: '8px 0' }

  // ---------- 登录卡 ----------
  const loginCard = h(ui.Card, { title: '① 登录微博' },
    logged
      ? h('div', null,
        h('div', { style: { fontSize: 15, marginBottom: 6 } }, `✅ 已登录：${acc.nickname || '（未知昵称）'}`),
        h('div', { className: 'ab-muted ab-small' }, `uid ${acc.uid || '-'} · 登录态保存于 ${acc.savedAt ? new Date(acc.savedAt).toLocaleString() : '未知'}`),
        h('div', { style: { marginTop: 10 } },
          h(ui.Btn, { onClick: doLogout, disabled: busy === 'logout' }, busy === 'logout' ? '退出中…' : '退出登录')))
      : h('div', null,
        h('div', { className: 'ab-note', style: { marginBottom: 6 } }, '点下面这一个按钮就行，登录全自动：'),
        h('div', { className: 'ab-small', style: { marginBottom: 10 } },
          '· 你这台机器有图形桌面 → 会直接弹出微博登录窗口，你在窗口里扫码/输账号，登录完我自动接住',
          h('br'),
          '· 没有桌面（服务器）→ 我会把二维码图片给你，手机微博扫一下，同样自动接住',
          h('br'),
          '· 全程**不需要你复制任何 cookie**'),
        h('div', { style: { margin: '10px 0' } },
          h(ui.Btn, { onClick: doQr, disabled: busy === 'qr' }, busy === 'qr' ? '正在打开微博登录…' : '登录微博')),
        hint ? h('div', { className: 'ab-small', style: { marginTop: 6 } }, hint) : null,
        qr ? h('div', { style: { textAlign: 'center', marginTop: 8 } },
          h('img', { src: qr, alt: '微博登录二维码', style: { width: 220, borderRadius: 10, border: '1px solid var(--ab-line)', background: '#fff' } }),
          h('div', { className: 'ab-muted ab-small' }, '微博 App → 我 → 右上角「扫一扫」；过期就再点一次「登录微博」'))
          : null,
        h('div', { className: 'ab-muted ab-small', style: { marginTop: 14, borderTop: '1px solid var(--ab-line)', paddingTop: 8 } },
          '扫码被微博风控挡住、或你想直接用现成会话时，可以改用「粘 Cookie」：',
          h('br'),
          h('span', { className: 'ab-small' },
            '电脑浏览器登录 weibo.com → F12 → Network → 任一请求 → Request Headers 的 Cookie 整行 → 发 /微博导入 <整行>'),
          h('br'),
          '（这一步只是兜底，正常情况用不到。详见 README「登录」一节。）')))

  // ---------- 档位卡 ----------
  const presetBtn = (name, label, desc) => h(ui.Btn, {
    onClick: () => {
      if (name === 'open' && !window.confirm('「全开」会真的把内容发到你的微博上（不再是试运行），确定切换？')) return
      doPreset(name)
    },
    disabled: Boolean(busy) || preset === name,
    style: { marginRight: 8, marginBottom: 6, opacity: preset === name ? 1 : 0.85 },
  }, `${preset === name ? '● ' : ''}${label}`)

  const presetCard = h(ui.Card, { title: '② 行为档位（一键，不用算参数）' },
    h('div', null,
      presetBtn('safe', '🟢 安全', ''),
      presetBtn('normal', '🟡 正常', ''),
      presetBtn('open', '🔴 全开', '')),
    h('div', { className: 'ab-small', style: { marginTop: 6 } },
      `当前：${preset === 'safe' ? '安全' : preset === 'normal' ? '正常' : preset === 'open' ? '全开' : '自定义'} · `,
      badge(!cfg.dryRun, '会真发', '试运行'),
      h('span', { className: 'ab-muted' }, ` · 间隔 ${cfg.minGapMinutes} 分钟 · 每天 ${cfg.caps ? cfg.caps.post : '-'} 条`)),
    h('div', { className: 'ab-muted ab-small', style: { marginTop: 6 } },
      '安全＝试运行+慢；正常＝试运行；全开＝**真的发出去**。不确定就留在「正常」。'))

  // ---------- 用量卡 ----------
  const bar = (label, used, cap) => h('div', { style: { margin: '6px 0' } },
    h('div', { className: 'ab-small', style: { display: 'flex', justifyContent: 'space-between' } },
      h('span', null, label), h('span', { className: 'ab-muted' }, `${used || 0} / ${cap || 0}`)),
    h('div', { style: { height: 6, borderRadius: 3, background: 'var(--ab-line)', marginTop: 4 } },
      h('div', {
        style: {
          height: 6, borderRadius: 3, width: Math.min(100, Math.round(((used || 0) / Math.max(1, cap || 1)) * 100)) + '%',
          background: (used || 0) >= (cap || 1) ? '#d93025' : '#1a7f45',
        },
      })))

  const usageCard = h(ui.Card, { title: '③ 今日用量' },
    bar('发微博', counts.post, cfg.caps && cfg.caps.post),
    bar('转发', counts.repost, cfg.caps && cfg.caps.repost),
    bar('评论', counts.comment, cfg.caps && cfg.caps.comment),
    counts.pausedDay
      ? h('div', { className: 'ab-small', style: { color: '#b3261e', marginTop: 8 } }, `⛔ 今天已停手：${counts.pauseReason}`)
      : h('div', { className: 'ab-muted ab-small', style: { marginTop: 8 } }, '微博要求验证时会自动停手一整天，不会硬试。'))

  // ---------- 高级设置 ----------
  const num = (key, label, min, max) => h('div', { style: rowStyle },
    h('div', null, h('div', { className: 'ab-small' }, label),
      h('div', { className: 'ab-muted ab-small' }, `${min}–${max}`)),
    h('input', {
      className: 'ab-input', type: 'number', min, max, value: settings[key] ?? '',
      style: { width: 100 },
      onChange: (e) => set({ [key]: Number(e.target.value) }),
    }))

  const sw = (key, label, hint) => h('div', { style: rowStyle },
    h('div', null, h('div', { className: 'ab-small' }, label),
      hint ? h('div', { className: 'ab-muted ab-small' }, hint) : null),
    h(ui.Switch, { checked: settings[key] !== false, onChange: (v) => set({ [key]: Boolean(v) }) }))

  const advCard = h(ui.Card, {
    title: h('span', null, '④ 高级设置 ',
      h('span', {
        className: 'ab-small', style: { cursor: 'pointer', color: 'var(--ab-accent, #2f6fed)' },
        onClick: () => setShowAdv(!showAdv),
      }, showAdv ? '收起' : '展开')),
  },
  showAdv
    ? h('div', null,
      sw('enabled', '微博功能开关', '只管微博模块；和页面顶部那个管整个机器人的「总开关」不是一回事'),
      sw('dryRun', '试运行', '开：只回“会发这条”；关：真发'),
      num('minGapMinutes', '两次操作最小间隔（分钟）', 0, 240),
      num('hotCount', '热搜默认条数', 1, 50),
      num('readLimit', '读微博默认条数', 1, 30),
      num('hotDigestHours', '热搜定时播报（小时，0=关）', 0, 48),
      h('div', { style: rowStyle },
        h('div', null, h('div', { className: 'ab-small' }, '登录方式'),
          h('div', { className: 'ab-muted ab-small' }, '扫码=截登录页二维码；纯接口=不需要浏览器')),
        h(ui.Select, {
          value: settings.loginMode || 'browser',
          options: [{ value: 'browser', label: '浏览器扫码' }, { value: 'http', label: '纯接口二维码' }],
          onChange: (v) => set({ loginMode: v }),
        })),
      h('div', { style: rowStyle },
        h('div', null, h('div', { className: 'ab-small' }, 'Chrome 路径（扫码用）'),
          h('div', { className: 'ab-muted ab-small' }, '留空自动找；无桌面环境会自动套 xvfb-run')),
        h('input', {
          className: 'ab-input', type: 'text', value: settings.browserPath || '',
          placeholder: '/usr/bin/google-chrome', style: { width: 220 },
          onChange: (e) => set({ browserPath: e.target.value }),
        })))
    : h('div', { className: 'ab-muted ab-small' }, '一般不用动。想细调再展开。'))

  // ---------- 说明卡 ----------
  const helpCard = h(ui.Card, { title: '说明' },
    h('div', { className: 'ab-small' },
      h('div', null, '· 写操作（发博/转发/评论）受三重限制：总开关 → 每日上限 → 最小间隔。'),
      h('div', null, '· 微博要求验证码时会自动停手一天并私聊告警，不会反复硬试。'),
      h('div', null, '· 群聊里只有只读工具；发博/评论只在你私聊时可用。'),
      h('div', null, '· 登录态存在本机 modules-data/weibo/cookies.json（权限 600），不写进插件配置。'),
      h('div', { className: 'ab-muted', style: { marginTop: 6 } },
        '完整说明见模块目录里的 README.md；QQ 里发 /微博帮助 也能看一步步指引。')))

  const dangerBar = danger
    ? h('div', {
      className: 'ab-small',
      style: { background: '#fdecec', color: '#b3261e', border: '1px solid #f3c2c2', borderRadius: 8, padding: '8px 10px', marginBottom: 10 },
    }, '⚠️ 当前是「真实发送」模式：发博 / 转发 / 评论会**真的发到微博上**。只想试效果就切回「安全」或「正常」档。')
    : null

  return h('div', null, dangerBar, loginCard, presetCard, usageCard, advCard, helpCard)
}
