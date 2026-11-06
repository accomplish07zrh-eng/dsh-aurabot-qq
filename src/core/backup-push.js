// 云备份推送：把 backups/ 里最新的备份 zip 推到 Gitee 私有仓库，按保留份数清旧的。
//
// 走本机 git（HTTPS + 私人令牌）：Gitee 的 Contents API 单文件只能放 ~1MB，
// 备份 zip 动辄几 MB，所以不用 API 传文件，只在本机留一个裸工作目录当「推送中转」。
// 安全约定（首审 5 项 P1，2026-11-03）：
//   ① 推送前用 Gitee API 校验目标仓库确实私有（private===true），公开仓库一律拒绝——
//      这是「备份不上公网」的唯一硬闸，面板红字提醒只算引导不算兜底；
//   ② 令牌不写进 .git/config：remote 只记不带凭证的 gitee.com URL，令牌经
//      GIT_CONFIG_* 环境变量以 http.extraheader（Basic，base64）喂给 git，进程参数里也不出现；
//   ③ 所有报错（git 子进程与 Gitee API）统一过 redact 再给人看，backup 令牌同时在
//      host.js 全局 secrets() 登记；
//   ④ owner/repo/branch 白名单校验（字母数字._- 等），防 URL 注入与 git 参数注入；
//   ⑤ 对远端已有内容的仓库不自动 --force（除非面板勾了「允许覆盖」），并写入
//      .aurabot-backup-marker 标记，防止误把自己的私有代码仓清空。

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { devNull } from 'node:os'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from './store.js'

const workDir = () => dataDir('backups', '.gitee')
/** 仓库里的归档根：每份备份一个日期命名文件夹 backups/aurabot-backup-YYYYMMDD-HHMM/。 */
const archiveRoot = (wd) => join(wd, 'backups')
const baseOf = (name) => name.replace(/\.zip(\.part\d+)?$/, '')
const GIT_TIMEOUT = 30 * 60 * 1000 // 推大包给足半小时，别让慢网把备份推一半掐死
const SPLIT_MAX_DEFAULT = 95 * 1024 * 1024 // Gitee 服务端单文件拒收 100MB，分卷留点余量
const MARKER = '.aurabot-backup-marker' // 备份仓标记：中转目录与远端仓库根都有它
/** owner/repo 白名单：Gitee 本来就只允许这些字符，这里收紧掉 @ : / ? # 空格等能改 URL 语义的字符。 */
const NAME_RE = /^[A-Za-z0-9_.-]+$/
/** 分支白名单：再拒掉 .. 与 - 开头，防 refspec/选项注入。 */
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/

// 测试钩子：测试注入假 spawn / fetch，不打真网络不真跑 git（对齐 petHooks 模式）；splitMax 调小测分卷
export const pushHooks = { spawn: null, fetch: null, splitMax: null }

/** 输出里的令牌换成 ***，别把凭证写进日志和面板。 */
export function redact(text, token) {
  const s = String(text ?? '')
  if (!token) return s
  return s.split(token).join('***')
}

/** remote 里永远只放不带凭证的 URL，令牌走环境变量（见 gitEnv）。 */
const cleanUrl = (r) => `https://gitee.com/${r.owner}/${r.repo}.git`

/**
 * 给 git 子进程的环境变量：令牌以 http.extraheader（Basic base64）注入，只进环境不进
 * 命令行、不进 .git/config；顺带关掉凭据管理器与终端交互提示，防止 token 被存到别处。
 */
function gitEnv(token) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_COUNT: '2' }
  env.GIT_CONFIG_KEY_0 = 'credential.helper'
  env.GIT_CONFIG_VALUE_0 = '' // 清空凭据助手链，别让 git 把令牌写进系统凭据库
  env.GIT_CONFIG_KEY_1 = 'http.extraheader'
  env.GIT_CONFIG_VALUE_1 = 'AUTHORIZATION: basic ' + Buffer.from(`oauth2:${token}`).toString('base64')
  return env
}

/** 保留 N 份的淘汰计划：输入归档根下的文件夹名（一份备份一个文件夹），倒序留前 N 个。纯函数方便测试。 */
export function prunePlan(dirs, keep) {
  const valid = dirs.filter((d) => /^aurabot-backup-\d{8}-\d{4}$/.test(d)).sort().reverse()
  const n = Math.max(1, keep)
  return { keep: valid.slice(0, n), drop: valid.slice(n) }
}

/** 跑一条 git 命令：超时/非零退出都报人话，输出过 redact，令牌经环境变量喂给 git。 */
function runGit(args, { cwd, token, onLog = () => {} }) {
  const doSpawn = pushHooks.spawn || spawn
  return new Promise((resolve) => {
    const child = doSpawn('git', args, { cwd, windowsHide: true, env: gitEnv(token) })
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

/** Gitee API（带令牌）：15 秒超时、禁重定向，令牌在 URL 查询参数里，任何异常包装并 redact 后再抛。 */
async function giteeApi(r, path, init) {
  const doFetch = pushHooks.fetch || fetch
  const token = String(r.token || '')
  const url = `https://gitee.com/api/v5${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
  let res
  try {
    res = await doFetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) })
  } catch (error) {
    throw new Error(redact('Gitee 接口连不上：' + (error?.message || error), token))
  }
  return res
}

/**
 * 推送前校验目标仓库真的私有（P1 硬闸）。
 * 返回 { exists }；仓库不存在返回 { exists: false } 让调用方决定要不要自动建。
 */
async function assertPrivate(r) {
  const token = String(r.token || '')
  const res = await giteeApi(r, `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`, { method: 'GET' })
  if (res.status === 404) return { exists: false }
  if (!res.ok) throw new Error('Gitee 仓库校验失败（HTTP ' + res.status + '）：令牌可能不对，或没有 repo 读权限，去 Gitee 设置→私人令牌检查一下')
  let info
  try {
    info = await res.json()
  } catch (error) {
    throw new Error(redact('Gitee 仓库校验失败：返回内容读不出来（' + (error?.message || error) + '）', token))
  }
  if (info.private !== true) throw new Error(`Gitee 仓库 ${r.owner}/${r.repo} 不是私有仓库，已拒绝推送：备份里有你全部的聊天记录、记忆和账号凭证，推到公开仓库等于把它们挂到网上。去 Gitee 把它改成「私有」，或换一个私有仓库名`)
  return { exists: true }
}

/** Gitee 上还没有仓库时帮主人建一个（私有的、不自动初始化，免得首推对不上历史）。异常一律包装并脱敏。 */
async function createRepo(r) {
  const res = await giteeApi(r, '/user/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: r.repo, private: true, auto_init: false }),
  })
  if (!res.ok) throw new Error('Gitee 上自动建仓库失败（HTTP ' + res.status + '）：令牌可能没有 projects 权限，去 Gitee 手动建一个私有仓库再试')
}

/** 中转目录的 .git 已存在时：把 remote URL 对齐当前配置（换仓库/换用户名后不会推错地方），令牌从不进 URL。 */
async function ensureRemote(wd, r, token, onLog) {
  let git = await runGit(['remote', 'set-url', 'origin', cleanUrl(r)], { cwd: wd, token, onLog })
  if (git.code !== 0) {
    git = await runGit(['remote', 'add', 'origin', cleanUrl(r)], { cwd: wd, token, onLog })
    if (git.code !== 0) throw new Error(human(git, 'git remote'))
  }
  // 兜底检查：无论哪条路，.git/config 里都不该有令牌（旧版可能写进去过）
  let config = ''
  try { config = readFileSync(join(wd, '.git', 'config'), 'utf8') } catch { /* 没有就当干净 */ }
  if (token && config.includes(token)) {
    rmSync(join(wd, '.git'), { recursive: true, force: true })
    throw new Error('检测到推送中转目录里残留了明文令牌（旧版本写的），已把中转目录清掉。重新点一次「立即推送」就会用干净方式重建')
  }
}

/** Gitee 拒收后的兜底：删掉中转目录的 .git 重新初始化，把现存备份文件夹合成一个干净提交。 */
async function resetHistory(wd, r, name, version, token, onLog) {
  rmSync(join(wd, '.git'), { recursive: true, force: true })
  let git = await runGit(['init', '-b', r.branch || 'master'], { cwd: wd, token, onLog })
  if (git.code !== 0) throw new Error(human(git, 'git init'))
  git = await runGit(['remote', 'add', 'origin', cleanUrl(r)], { cwd: wd, token, onLog })
  if (git.code !== 0) throw new Error(human(git, 'git remote'))
  await runGit(['add', '-A'], { cwd: wd, token, onLog })
  const commit = await runGit(['commit', '-m', `backup ${name}${version ? ' (aurabot v' + version + ')' : ''} (clean history)`], { cwd: wd, token, onLog })
  if (commit.code !== 0 && !/nothing to commit/i.test(commit.err + commit.out)) throw new Error(human(commit, 'git commit'))
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
  // 输入白名单（P1-4）：owner/repo 只允许仓库合法字符，branch 拒 .. 和 - 开头，
  // 防 token/owner/repo/branch 把 URL 或 git 参数改语义（如 token=x@evil.example/ 把备份发去别处）
  if (!NAME_RE.test(String(r.owner))) throw new Error('Gitee 用户名格式不对：只能用字母、数字、点、下划线和连字符（去 Gitee 主页确认一下那串 ID）')
  if (!NAME_RE.test(String(r.repo))) throw new Error('仓库名格式不对：只能用字母、数字、点、下划线和连字符，不能带路径或特殊字符（如 ../other、a/b、a?b）')
  const branch = String(r.branch || 'master')
  if (!BRANCH_RE.test(branch) || branch.includes('..') || branch.startsWith('-') || branch.startsWith('/')) throw new Error('分支名格式不对：只能用字母、数字、点、下划线、连字符和斜杠，且不能以 - 或 .. 开头')
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

  // 第一次用：初始化中转目录（remote 只记干净 URL）；已有的话把 remote 对齐当前配置
  if (!existsSync(join(wd, '.git'))) {
    let git = await runGit(['init', '-b', branch], { cwd: wd, token, onLog })
    if (git.code !== 0) throw new Error(human(git, 'git init'))
    git = await runGit(['remote', 'add', 'origin', cleanUrl(r)], { cwd: wd, token, onLog })
    if (git.code !== 0) throw new Error(human(git, 'git remote'))
  } else {
    await ensureRemote(wd, r, token, onLog)
  }

  // P1-1 硬闸：推送前先问 Gitee API「这个仓库是私有的吗」，公开仓/非仓直接拒绝，不碰 git
  onLog({ out: '推送前校验目标仓库私有性…' })
  let exists = await assertPrivate(r)
  if (!exists.exists) {
    if (r.autoCreate !== false) {
      onLog({ err: '远端没有仓库，试着自动建一个私有的…' })
      await createRepo(r)
      exists = await assertPrivate(r) // 自动建完复核响应：建出来必须真是私有的
      if (!exists.exists) throw new Error('自动建仓后仍然查不到这个仓库：去 Gitee 网页上看一眼（可能是网络延迟），稍后重试')
    } else {
      throw new Error('Gitee 上找不到这个仓库：确认仓库名没写错，或在 Gitee 上先建一个（私有的）')
    }
  }

  let check = await runGit(['ls-remote', '--heads', 'origin'], { cwd: wd, token, onLog })
  if (check.code !== 0) throw new Error(human(check, '连接仓库'))

  // P1-5：备份仓标记。写进中转目录根（随 add -A 推到远端仓库根），
  // 远端已有内容时只有在「autoCreate 可用 +（空仓库或面板勾了允许覆盖）」才自动 --force
  if (!existsSync(join(wd, MARKER))) writeFileSync(join(wd, MARKER), `aurabot 云备份推送中转目录\n目标：gitee.com/${r.owner}/${r.repo}\n远端仓库根的同名文件用来识别「这是备份专用仓」。\n`)
  const remoteHasContent = /refs\/heads\//.test(check.out || '')
  const mayAutoForce = r.autoCreate !== false && (r.forceOverwrite === true || !remoteHasContent)
  const refuseAutoForce = (why) => {
    throw new Error(why + '。为安全起见不会自动覆盖：确认这个仓库确实是备份专用（空仓或本来就是备份仓）后，到面板云备份里勾上「允许覆盖已有内容的仓库」再推')
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
  const doPush = (extra = []) => runGit(['push', '-u', 'origin', 'HEAD:' + branch, ...extra], { cwd: wd, token, onLog })
  const declined = (p) => /pre-receive hook declined/i.test(p.err + p.out)
  const diverged = (p) => /fetch first|non-fast-forward/i.test(p.err + p.out)
  let push = await doPush()
  if (declined(push)) {
    // 历史（多半是以前失败尝试留下的超限大文件）让服务端拒收：清掉本地推送历史，
    // 把当前保留的备份重新合成一个干净提交再推。顺带解决历史膨胀吃满仓库容量的问题。
    // 但远端已有内容且没勾「允许覆盖」时，重置历史意味着强推覆盖——先拦下来问人。
    if (!mayAutoForce) refuseAutoForce('Gitee 拒收了这次推送：要清掉远端历史重推（多半是以前失败尝试留下的超限大文件）')
    onLog({ err: '被 Gitee 拒收：推送历史里有超限大文件，重置历史再来一次…' })
    await resetHistory(wd, r, name, version, token, onLog)
    push = await doPush(['--force']) // 新历史和远端对不上，直接覆盖（备份镜像仓，远端内容本来就该跟本地走）
  } else if (diverged(push)) {
    // 远端有旧历史（比如上次推成功过、后来本地重置过）：备份仓以本地为准，覆盖推送。
    // 远端已有内容且没勾「允许覆盖」时绝不自动覆盖——万一是误填的私有代码仓，会清空别人的历史。
    if (!mayAutoForce) refuseAutoForce('远端仓库里已经有内容（不是本工具推出来的备份仓）')
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
