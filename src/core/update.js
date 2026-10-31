// 检查更新：读 GitHub 上主分支的 package.json，比版本号。结果缓存 6 小时。

const STAGE = { alpha: 1, beta: 2, rc: 3 }

/** 比较 x.y.z、x.y.z-beta.n、x.y.z-rc.n：a > b 返回正数；同一版本号里 beta < rc < 正式版。 */
export function compareVersions(a, b) {
  const [ca, ba] = String(a || '0').split('-')
  const [cb, bb] = String(b || '0').split('-')
  const pa = ca.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = cb.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  if (!ba || !bb) return (ba ? 0 : 1) - (bb ? 0 : 1)
  const [sa, na] = ba.split('.')
  const [sb, nb] = bb.split('.')
  if (sa !== sb) return (STAGE[sa] || 0) - (STAGE[sb] || 0)
  return (parseInt(na, 10) || 0) - (parseInt(nb, 10) || 0)
}

/** 测试版走 beta 分支，正式版走 main：互不打扰。 */
export const channelOf = (version) => (String(version).includes('-') ? 'beta' : 'main')

/** 订阅不稳定版本：主人选过就听主人的，没选过时正在用测试版的算已订阅，免得老测试用户收不到更新。 */
export const wantsUnstable = (choice, version) => (typeof choice === 'boolean' ? choice : channelOf(version) === 'beta')

/** 从 repository.url 拿 owner/repo。 */
export function repoOf(pkg) {
  const url = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url || ''
  const m = String(url).match(/github\.com[/:]([^/]+)\/([^/.]+)/)
  return m ? `${m[1]}/${m[2]}` : ''
}

/** 更新命令：把安装命令再跑一次就会拉到最新版。 */
export function updateCommand(repo, channel = 'main') {
  return `& "$env:LOCALAPPDATA\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd" plugin --profile desktop add github:${repo}${channel === 'main' ? '' : '#' + channel}`
}

export function createUpdateChecker({ pkg, log, fetchImpl = fetch, unstable = () => null }) {
  let cache = null
  return async function check({ force = false } = {}) {
    const repo = repoOf(pkg)
    if (!repo) return { ok: false, current: pkg.version, message: '不知道从哪检查更新' }
    const subscribed = wantsUnstable(unstable(), pkg.version)
    if (!force && cache && cache.subscribed === subscribed && Date.now() - cache.at < 6 * 3600_000) return cache.value
    try {
      // 没订阅只看 main；订阅了两边都看：转正后 main 可能比 beta 新
      const readVersion = async (branch) => {
        let lastError = null
        // raw.githubusercontent.com 国内常连不上，不行就走 jsDelivr
        for (const url of [`https://raw.githubusercontent.com/${repo}/${branch}/package.json`, `https://cdn.jsdelivr.net/gh/${repo}@${branch}/package.json`]) {
          try {
            const r = await fetchImpl(url, { signal: AbortSignal.timeout(8000) })
            if (!r.ok) throw new Error('HTTP ' + r.status)
            const version = (await r.json()).version
            if (version) return version
          } catch (error) {
            lastError = error
          }
        }
        throw lastError || new Error('拿不到版本号')
      }
      const found = []
      let lastError = null
      for (const branch of subscribed ? ['beta', 'main'] : ['main']) {
        try { found.push({ branch, version: await readVersion(branch) }) } catch (error) { lastError = error }
      }
      if (!found.length) throw lastError
      const best = found.reduce((a, b) => (compareVersions(b.version, a.version) > 0 ? b : a))
      const latest = best.version
      const channel = best.branch
      const value = { ok: true, current: pkg.version, latest, newer: compareVersions(latest, pkg.version) > 0, repo, unstable: subscribed, channel, command: updateCommand(repo, channel) }
      cache = { at: Date.now(), value, subscribed }
      return value
    } catch (error) {
      log?.debug('检查更新失败：', error.message)
      return { ok: false, current: pkg.version, message: '检查更新失败：' + error.message }
    }
  }
}

/** CHANGELOG.md 里某个版本那一段（「## 0.3.0」到下一个「## 」）。 */
export function changelogSection(text, version) {
  const lines = String(text || '').split(/\r?\n/)
  const start = lines.findIndex((l) => new RegExp(`^##\\s+v?${String(version).replace(/\./g, '\\.')}\\b`).test(l))
  if (start < 0) return ''
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()
}
