// 云备份推送：把 backups/ 里最新的备份 zip 推到 Gitee 私有仓库，按保留份数清旧的。
//
// 走本机 git（HTTPS + 私人令牌当密码）：Gitee 的 Contents API 单文件只能放 ~1MB，
// 备份 zip 动辄几 MB，所以不用 API 传文件，只在本机留一个裸工作目录当「推送中转」。
// 令牌只出现在 remote URL 里，所有输出先过 redact 再给人看/写日志。

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from './store.js'

const workDir = () => dataDir('backups', '.gitee')
/** 仓库里的归档根：每份备份一个日期命名文件夹 backups/aurabot-backup-YYYYMMDD-HHMM/。 */
const archiveRoot = (wd) => join(wd, 'backups')
const baseOf = (name) => name.replace(/\.zip(\.part\d+)?$/, '')
const GIT_TIMEOUT = 30 * 60 * 1000 // 推大包给足半小时，别让慢网把备份推一半掐死
const SPLIT_MAX_DEFAULT = 95 * 1024 * 1024 // Gitee 服务端单文件拒收 100MB，分卷留点余量

// 测试钩子：测试注入假 spawn / fetch，不打真网络不真跑 git（对齐 petHooks 模式）；splitMax 调小测分卷
export const pushHooks = { spawn: null, fetch: null, splitMax: null }

/** 输出里的令牌换成 ***，别把凭证写进日志和面板。 */
export function redact(text, token) {
  const s = String(text ?? '')
  if (!token) return s
  return s.split(token).join('***')
}

const repoUrl = (r) => `https://oauth2:${r.token}@gitee.com/${r.owner}/${r.repo}.git`

/** 保留 N 份的淘汰计划：输入归档根下的文件夹名（一份备份一个文件夹），倒序留前 N 个。纯函数方便测试。 */
export function prunePlan(dirs, keep) {
  const valid = dirs.filter((d) => /^aurabot-backup-\d{8}-\d{4}$/.test(d)).sort().reverse()
  const n = Math.max(1, keep)
  return { keep: valid.slice(0, n), drop: valid.slice(n) }
}

/** 跑一条 git 命令：超时/非零退出都报人话，输出过 redact。 */
function runGit(args, { cwd, token, onLog = () => {} }) {
  const doSpawn = pushHooks.spawn || spawn
  return new Promise((resolve) => {
    const child = doSpawn('git', args, { cwd, windowsHide: true })
    let out = ''
    let err = ''
    let done = false
    const timer = setTimeout(() => { done = true; try { child.kill() } catch { /* 已经退了就算了 */ } resolve({ code: -1, out: redact(out, token), err: redact(err, token) + '\n超时：半小时还没推完，先断了' }) }, GIT_TIMEOUT)
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { err += d })
    child.on('error', (error) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, out: redact(out, token), err: redact(error.message, token) }) } })
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: code ?? -1, out: redact(out, token), err: redact(err, token) }) } })
  }).then((r) => { onLog(r); return r })
}

const human = (r, what) => {
  if (/git.*不是内部或外部命令|ENOENT|command not found/i.test(r.err + r.out)) return `这台电脑没装 git（${what} 失败）。装一个 git 再试：https://git-scm.com/downloads`
  if (/Authentication failed|403|401|could not read Username/i.test(r.err)) return 'Gitee 令牌不对或过期了：去 Gitee 设置→私人令牌重新生成一个，填进面板再试'
  if (/not found|does not appear to be a git repository|repository.*not.*exist/i.test(r.err)) return 'Gitee 上找不到这个仓库：确认仓库名没写错，或在 Gitee 上先建一个（私有的）'
  if (/pre-receive hook declined/i.test(r.err + r.out)) return 'Gitee 拒收了这次推送：多半是单文件超过 100MB（超过 95MB 会自动分卷，还报这个就是仓库容量满了，去 Gitee 清掉一些旧提交或调小「远端留几份」）'
  const detail = (r.err || r.out || '').trim().split('\n').filter(Boolean).slice(-3).join('；')
  return `${what}失败${detail ? '：' + detail : ''}`
}

/** Gitee 拒收后的兜底：删掉中转目录的 .git 重新初始化，把现存备份文件夹合成一个干净提交。 */
async function resetHistory(wd, r, name, version, token, onLog) {
  rmSync(join(wd, '.git'), { recursive: true, force: true })
  let git = await runGit(['init', '-b', r.branch || 'master'], { cwd: wd, token, onLog })
  if (git.code !== 0) throw new Error(human(git, 'git init'))
  git = await runGit(['remote', 'add', 'origin', repoUrl(r)], { cwd: wd, token, onLog })
  if (git.code !== 0) throw new Error(human(git, 'git remote'))
  await runGit(['add', '-A'], { cwd: wd, token, onLog })
  const commit = await runGit(['commit', '-m', `backup ${name}${version ? ' (aurabot v' + version + ')' : ''} (clean history)`], { cwd: wd, token, onLog })
  if (commit.code !== 0 && !/nothing to commit/i.test(commit.err + commit.out)) throw new Error(human(commit, 'git commit'))
}

/** Gitee 上还没有仓库时帮主人建一个（私有的、不自动初始化，免得首推对不上历史）。 */
async function createRepo(r) {
  const doFetch = pushHooks.fetch || fetch
  const res = await doFetch('https://gitee.com/api/v5/user/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ access_token: r.token, name: r.repo, private: true, auto_init: false }),
  })
  if (!res.ok) throw new Error('Gitee 上自动建仓库失败（HTTP ' + res.status + '）：令牌可能没有 projects 权限，去 Gitee 手动建一个私有仓库再试')
}

/**
 * 把最新备份推到 Gitee。返回 { ok, name, kept, dropped, message }。
 * 失败抛错，报错文案都过 redact，不带令牌。
 */
export async function pushBackup(remote, { version = '', onLog = () => {} } = {}) {
  const r = remote || {}
  const token = String(r.token || '')
  if (!r.owner || !r.repo) throw new Error('先在面板填 Gitee 用户名和仓库名')
  if (!token) throw new Error('先在面板填 Gitee 私人令牌（要 projects + repo 权限）')
  const dir = join(dataDir('backups'))
  const zips = existsSync(dir) ? readdirSync(dir).filter((n) => /^aurabot-backup-\d{8}-\d{4}\.zip$/.test(n)).sort().reverse() : []
  if (!zips.length) throw new Error('还没有备份文件：先「立即备份」一次，或等每天到点自动打包')
  const name = zips[0]
  const base = baseOf(name)
  const wd = workDir()
  mkdirSync(wd, { recursive: true })
  const root = archiveRoot(wd)
  mkdirSync(root, { recursive: true })
  // 旧版结构把 zip/分卷平铺在中转目录根：挪进各自文件夹（迁移一次），后面按文件夹统一处理
  for (const f of readdirSync(wd).filter((f) => /^aurabot-backup-\d{8}-\d{4}\.zip(\.part\d+)?$/.test(f))) {
    const b = baseOf(f)
    mkdirSync(join(root, b), { recursive: true })
    try { renameSync(join(wd, f), join(root, b, f)) } catch { copyFileSync(join(wd, f), join(root, b, f)); rmSync(join(wd, f), { force: true }) }
  }

  // 第一次用：初始化中转目录；远端仓库不存在时按配置自动建（私有）
  if (!existsSync(join(wd, '.git'))) {
    let git = await runGit(['init', '-b', r.branch || 'master'], { cwd: wd, token, onLog })
    if (git.code !== 0) throw new Error(human(git, 'git init'))
    git = await runGit(['remote', 'add', 'origin', repoUrl(r)], { cwd: wd, token, onLog })
    if (git.code !== 0) throw new Error(human(git, 'git remote'))
  }
  let check = await runGit(['ls-remote', '--heads', repoUrl(r)], { cwd: wd, token, onLog })
  if (check.code !== 0) {
    const why = human(check, '连接仓库')
    if (r.autoCreate !== false && /找不到这个仓库/.test(why)) {
      onLog({ err: '远端没有仓库，试着自动建一个私有的…' })
      await createRepo(r)
      check = await runGit(['ls-remote', '--heads', repoUrl(r)], { cwd: wd, token, onLog })
      if (check.code !== 0) throw new Error(human(check, '连接仓库'))
    } else throw new Error(why)
  }

  // 淘汰计划：归档根下一份备份一个文件夹，倒序留最近 N 个文件夹，远端与本地的旧文件夹一起清
  const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  const plan = prunePlan([...dirs.filter((d) => d !== base), base], Math.max(1, Math.round(Number(r.keep) || 7)))
  for (const old of plan.drop) {
    rmSync(join(root, old), { recursive: true, force: true })
    await runGit(['rm', '-r', '-f', '--ignore-unmatch', `backups/${old}`], { cwd: wd, token, onLog })
  }

  // 把这次的备份写进自己的文件夹；超 Gitee 单文件限制就自动分卷（xxx.zip.part01/02/…），恢复时按顺序合并回一个 zip
  const outDir = join(root, base)
  mkdirSync(outDir, { recursive: true })
  const splitMax = pushHooks.splitMax || SPLIT_MAX_DEFAULT
  const size = statSync(join(dir, name)).size
  const pushed = []
  if (size <= splitMax) {
    copyFileSync(join(dir, name), join(outDir, name))
    pushed.push(name)
  } else {
    const data = await readFile(join(dir, name))
    const count = Math.ceil(size / splitMax)
    for (let i = 0; i < count; i++) {
      const part = `${name}.part${String(i + 1).padStart(2, '0')}`
      await writeFile(join(outDir, part), data.subarray(i * splitMax, Math.min(size, (i + 1) * splitMax)))
      pushed.push(part)
    }
    // 文件夹里剩下的旧文件（上次是整包或分卷更多）：一并清掉
    for (const stale of readdirSync(outDir).filter((f) => !pushed.includes(f))) {
      rmSync(join(outDir, stale), { force: true })
      await runGit(['rm', '-f', '--ignore-unmatch', `backups/${base}/${stale}`], { cwd: wd, token, onLog })
    }
  }
  await runGit(['add', '-A'], { cwd: wd, token, onLog })

  let commit = await runGit(['commit', '-m', `backup ${name}${version ? ' (aurabot v' + version + ')' : ''}`], { cwd: wd, token, onLog })
  if (commit.code !== 0 && !/nothing to commit/i.test(commit.err + commit.out)) throw new Error(human(commit, 'git commit'))
  const doPush = (extra = []) => runGit(['push', '-u', 'origin', 'HEAD:' + (r.branch || 'master'), ...extra], { cwd: wd, token, onLog })
  const declined = (p) => /pre-receive hook declined/i.test(p.err + p.out)
  const diverged = (p) => /fetch first|non-fast-forward/i.test(p.err + p.out)
  let push = await doPush()
  if (declined(push)) {
    // 历史（多半是以前失败尝试留下的超限大文件）让服务端拒收：清掉本地推送历史，
    // 把当前保留的备份重新合成一个干净提交再推。顺带解决历史膨胀吃满仓库容量的问题。
    onLog({ err: '被 Gitee 拒收：推送历史里有超限大文件，重置历史再来一次…' })
    await resetHistory(wd, r, name, version, token, onLog)
    push = await doPush(['--force']) // 新历史和远端对不上，直接覆盖（备份镜像仓，远端内容本来就该跟本地走）
  } else if (diverged(push)) {
    // 远端有旧历史（比如上次推成功过、后来本地重置过）：备份仓以本地为准，覆盖推送
    onLog({ err: '远端有旧历史，直接覆盖推送…' })
    push = await doPush(['--force'])
    if (declined(push)) { // 覆盖还被拒 = 本地历史里也有超限文件，重置后再来
      await resetHistory(wd, r, name, version, token, onLog)
      push = await doPush(['--force'])
    }
  }
  if (push.code !== 0) throw new Error(human(push, 'git push'))
  const splitNote = pushed.length > 1 ? `（${pushed.length} 卷，每卷 <100MB，恢复时按顺序合并）` : `（${name}）`
  return { ok: true, name, folder: `backups/${base}`, parts: pushed.length, kept: plan.keep.length, dropped: plan.drop.length, message: `已推送 backups/${base}/${splitNote}（远端保留 ${plan.keep.length} 份${plan.drop.length ? '，清了 ' + plan.drop.length + ' 份旧的' : ''}）` }
}
