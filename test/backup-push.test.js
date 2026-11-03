import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let push
const root = mkdtempSync(join(tmpdir(), 'aurabot-backup-push-'))

// 假 git：不真跑命令，把「执行过什么」记下来；行为按真实 git 的关键特征模拟
// （init 建 .git、commit 失败时说 nothing to commit、push 成功退出 0）。
let commands = []
let failOn = null // 命令名 → 让它失败，测报错路径
// 假子进程：像真 git 一样用 stdout/stderr 的 data 事件发内容，close 时带退出码
const childOf = ({ code, out = '', err = '' }) => ({
  stdout: { on(ev, fn) { if (ev === 'data' && out) setImmediate(() => fn(Buffer.from(out))) } },
  stderr: { on(ev, fn) { if (ev === 'data' && err) setImmediate(() => fn(Buffer.from(err))) } },
  on(ev, fn) { if (ev === 'close') setImmediate(() => fn(code)) },
})
const okChild = () => childOf({ code: 0 })
const failChild = (msg, code = 1) => childOf({ code, err: msg })
const fakeSpawn = (cmd, args, { cwd, env }) => {
  const name = args[0]
  commands.push({ cmd, args, cwd, env })
  if (failOn === name && name !== 'init') return failChild(`remote: fatal error on ${name}`)
  if (name === 'init') { mkdirSync(join(cwd, '.git'), { recursive: true }); return okChild() }
  return okChild()
}

// 私有仓库 API 桩：默认 private:true（过 P1-1 硬闸）；个别用例再换掉
let apiRepo = { private: true }
let apiBodies = [] // createRepo 收到的请求体（断言 access_token 不在 body 里）
const okApi = async () => ({ ok: true, status: 200, json: async () => apiRepo })
const notFoundApi = async () => ({ ok: false, status: 404 })

before(async () => {
  process.env.AURABOT_DATA_DIR = root
  push = await import('../src/core/backup-push.js')
  push.pushHooks.spawn = fakeSpawn
  push.pushHooks.fetch = okApi
})

after(() => rmSync(root, { recursive: true, force: true }))

const remote = { owner: 'owner-x', repo: 'repo-x', token: 'SECRET_TOKEN_A1', branch: 'master', keep: 2, autoCreate: true }
const putZip = (name) => writeFileSync(join(root, 'backups', name), name)
const backup = (n) => { mkdirSync(join(root, 'backups'), { recursive: true }); putZip(n) }
// 每个用例自己重置状态：清整个 backups 目录（含中转目录与前面用例留下的 zip）、恢复默认桩、清命令记录
const fresh = () => { rmSync(join(root, 'backups'), { recursive: true, force: true }); commands = []; failOn = null; apiRepo = { private: true }; push.pushHooks.fetch = okApi; push.pushHooks.spawn = fakeSpawn }
// 读 .git/config（假 git 不一定造这个文件，读不到当空串）
const readGitConfig = (wd) => { try { return readFileSync(join(wd, '.git', 'config'), 'utf8') } catch { return '' } }

test('保留 N 份的淘汰计划：文件夹倒序留前 N 个，非备份文件夹不掺和', () => {
  const plan = push.prunePlan(['aurabot-backup-20261102-0330', 'aurabot-backup-20261101-0330', 'aurabot-backup-20261031-0330', 'not-backup'], 2)
  assert.deepEqual(plan.keep, ['aurabot-backup-20261102-0330', 'aurabot-backup-20261101-0330'])
  assert.deepEqual(plan.drop, ['aurabot-backup-20261031-0330'])
})

test('令牌在任何输出里都不出现', () => {
  const leak = `fatal: could not read Username for 'https://oauth2:SECRET_TOKEN_A1@gitee.com': terminal prompts disabled`
  assert.equal(push.redact(leak, 'SECRET_TOKEN_A1').includes('SECRET_TOKEN_A1'), false)
  assert.ok(push.redact(leak, 'SECRET_TOKEN_A1').includes('***'))
})

test('完整推送：init → remote → 校验私有 → ls-remote → add → commit → push（首次中转目录是空的，没有旧的可清）', async () => {
  fresh()
  backup('aurabot-backup-20261101-0330.zip')
  backup('aurabot-backup-20261102-0330.zip')
  backup('aurabot-backup-20261103-0330.zip')
  const r = await push.pushBackup(remote, { version: '1.2.0' })
  assert.equal(r.ok, true)
  assert.equal(r.name, 'aurabot-backup-20261103-0330.zip')
  assert.equal(r.kept, 1)
  assert.equal(r.dropped, 0)
  const names = commands.map((c) => c.args[0])
  assert.deepEqual(names, ['init', 'remote', 'ls-remote', 'add', 'commit', 'push'])
  // remote 只记干净 URL，令牌不进 .git/config（P1-2）
  const urlArg = commands.find((c) => c.args[0] === 'remote').args.find((a) => a.startsWith('https://'))
  assert.equal(urlArg, 'https://gitee.com/owner-x/repo-x.git')
  // 令牌经环境变量 http.extraheader（Basic base64）喂给 git，不进命令行（P1-2）
  const env = commands[0].env
  assert.equal(env.GIT_CONFIG_VALUE_1, 'AUTHORIZATION: basic ' + Buffer.from('oauth2:SECRET_TOKEN_A1').toString('base64'))
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  // 推送前确实校验过私有性（P1-1）：API 被调用过，且查询参数里带了令牌
  let fetchUrl = ''
  push.pushHooks.fetch = async (url) => { fetchUrl = url; return okApi() }
  await push.pushBackup({ ...remote, keep: 1 })
  assert.ok(fetchUrl.includes('/repos/owner-x/repo-x'))
  assert.ok(fetchUrl.includes('access_token=SECRET_TOKEN_A1'))
  push.pushHooks.fetch = okApi
  // 工作目录在 backups/.gitee（数据目录内、不进备份）；归档结构：backups/<日期文件夹>/<zip>
  assert.equal(r.folder, 'backups/aurabot-backup-20261103-0330')
  assert.equal(readFileSync(join(root, 'backups', '.gitee', 'backups', 'aurabot-backup-20261103-0330', r.name), 'utf8'), r.name)
  // .git/config 里没有令牌（P1-2），且带上了备份仓标记（P1-5）
  assert.equal(readGitConfig(join(root, 'backups', '.gitee')).includes('SECRET_TOKEN_A1'), false)
  assert.equal(existsSync(join(root, 'backups', '.gitee', '.aurabot-backup-marker')), true)
})

test('第二次推送会清掉旧备份文件夹（远端跟着清，keep=1 只留最新）', async () => {
  fresh()
  backup('aurabot-backup-20261103-0330.zip')
  await push.pushBackup(remote) // 先推一次把 .git 和标记建起来
  backup('aurabot-backup-20261104-0330.zip')
  const r = await push.pushBackup({ ...remote, keep: 1 }, { version: 'x' })
  assert.equal(r.kept, 1)
  assert.equal(r.dropped, 1) // 20261103 那个文件夹被清掉
  const rms = commands.filter((c) => c.args[0] === 'rm').map((c) => c.args[c.args.length - 1])
  assert.ok(rms.includes('backups/aurabot-backup-20261103-0330'))
  const root_ = join(root, 'backups', '.gitee', 'backups')
  assert.deepEqual(readdirSync(root_).filter((n) => n.startsWith('aurabot')), ['aurabot-backup-20261104-0330'])
})

test('没填令牌/仓库直接拒绝，且报错不带令牌', async () => {
  await assert.rejects(push.pushBackup({ ...remote, token: '' }), /私人令牌/)
  await assert.rejects(push.pushBackup({ ...remote, owner: '', repo: '' }), /用户名和仓库/)
})

test('P1-4 输入注入：owner/repo/branch 的非法字符一律拒绝；令牌永远不进命令行', async () => {
  await assert.rejects(push.pushBackup({ ...remote, owner: '../evil' }), /用户名格式不对/)
  await assert.rejects(push.pushBackup({ ...remote, repo: '../other/repo' }), /仓库名格式不对/)
  await assert.rejects(push.pushBackup({ ...remote, repo: 'a?b' }), /仓库名格式不对/)
  await assert.rejects(push.pushBackup({ ...remote, branch: '--bare' }), /分支名格式不对/)
  await assert.rejects(push.pushBackup({ ...remote, branch: 'a..b' }), /分支名格式不对/)
  // token 带特殊字符（x@evil.example/）：不允许其改变 URL 语义——git 只收 origin（干净 URL）与
  // 环境变量里的 Basic 头，命令行任何参数都不出现原始令牌
  fresh()
  backup('aurabot-backup-20261103-0330.zip')
  await push.pushBackup({ ...remote, token: 'x@evil.example/' })
  for (const c of commands) {
    assert.equal(c.args.some((a) => String(a).includes('x@evil.example/')), false, '令牌出现在命令行参数里：' + c.args.join(' '))
    assert.equal(c.args.some((a) => String(a).includes('evil.example')), false, '推送被引去 evil.example 了')
  }
})

test('P1-1 私有性硬闸：公开仓库直接拒绝推送，报错不带令牌', async () => {
  fresh()
  backup('aurabot-backup-20261103-0330.zip')
  apiRepo = { private: false }
  await assert.rejects(push.pushBackup(remote), /不是私有仓库，已拒绝推送/)
  assert.equal(commands.filter((c) => c.args[0] === 'push').length, 0, '公开仓连 git push 都不许发生')
  // 报错文案不带令牌
  await assert.rejects(push.pushBackup(remote), (e) => { assert.equal(String(e.message).includes('SECRET_TOKEN_A1'), false); return /不是私有仓库，已拒绝推送/.test(e.message) })
})

test('P1-1 私有性硬闸：校验接口挂了也不推（fail-closed），异常里的令牌被脱掉', async () => {
  fresh()
  backup('aurabot-backup-20261103-0330.zip')
  // 模拟底层 fetch 的异常消息带着完整带 token 的 URL
  push.pushHooks.fetch = async () => { throw new TypeError('fetch failed: https://gitee.com/api/v5/repos/owner-x/repo-x?access_token=SECRET_TOKEN_A1 connect ECONNREFUSED') }
  await assert.rejects(push.pushBackup(remote), (e) => {
    assert.equal(String(e.message).includes('SECRET_TOKEN_A1'), false, '抛出去的错误不能带令牌')
    return /Gitee 接口连不上/.test(e.message)
  })
  assert.equal(commands.filter((c) => c.args[0] === 'push').length, 0)
})

test('P1-3 真实错误路径脱敏：createRepo 的 fetch 异常/HTTP 失败都只给人话，不带令牌', async () => {
  fresh()
  backup('aurabot-backup-20261103-0330.zip')
  // 场景一：仓库不存在 → 走 createRepo → 底层 fetch 抛带 token 的异常 → 包装脱敏
  let first = true
  push.pushHooks.fetch = async () => {
    if (first) { first = false; return notFoundApi() }
    throw Object.assign(new TypeError('fetch failed: https://gitee.com/api/v5/user/repos?access_token=SECRET_TOKEN_A1'), { cause: { code: 'ECONNRESET' } })
  }
  await assert.rejects(push.pushBackup({ ...remote, repo: 'repo-new' }), (e) => {
    assert.equal(String(e.message).includes('SECRET_TOKEN_A1'), false, 'createRepo 的 fetch 异常不能带令牌')
    return /Gitee 接口连不上/.test(e.message)
  })
  // 场景二：createRepo 的 HTTP 失败（403）也给人话
  fresh()
  backup('aurabot-backup-20261103-0330.zip')
  let saw404 = false
  push.pushHooks.fetch = async (url) => {
    if (String(url).includes('/user/repos')) return { ok: false, status: 403 }
    if (!saw404) { saw404 = true; return notFoundApi() }
    return okApi()
  }
  await assert.rejects(push.pushBackup({ ...remote, repo: 'repo-new' }), /自动建仓库失败（HTTP 403）/)
})

test('仓库不存在时自动建一个私有的，建完复核私有性；access_token 不进请求体', async () => {
  fresh()
  backup('aurabot-backup-20261103-0330.zip')
  let sawNotFound = false
  push.pushHooks.fetch = async (url, init) => {
    if (String(url).includes('/user/repos')) {
      apiBodies.push({ url: String(url), body: JSON.parse(init.body) })
      return { ok: true, status: 201 }
    }
    if (!sawNotFound) { sawNotFound = true; return notFoundApi() }
    return okApi()
  }
  const r = await push.pushBackup(remote)
  assert.equal(r.ok, true)
  assert.equal(apiBodies.length, 1)
  assert.equal(apiBodies[0].body.access_token, undefined, '令牌走 URL 查询参数，不进 JSON 请求体')
  assert.deepEqual({ name: apiBodies[0].body.name, private: apiBodies[0].body.private, auto_init: apiBodies[0].body.auto_init }, { name: 'repo-x', private: true, auto_init: false })
  assert.equal(sawNotFound, true)
  // 建完复核：第二次 GET 必须真的问过
})

test('autoCreate 建出来的仓不是私有（服务端异常），复核后拒绝推送', async () => {
  fresh()
  backup('aurabot-backup-20261103-0330.zip')
  let first = true
  push.pushHooks.fetch = async (url) => {
    if (String(url).includes('/user/repos')) return { ok: true, status: 201 }
    if (first) { first = false; return notFoundApi() }
    return { ok: true, status: 200, json: async () => ({ private: false }) } // 建完查出来却是公开的：异常情况
  }
  await assert.rejects(push.pushBackup(remote), /不是私有仓库，已拒绝推送/)
})

test('P1-2 换仓库后 remote URL 会更新（set-url），令牌永远不在 .git/config 里', async () => {
  fresh()
  backup('aurabot-backup-20261103-0330.zip')
  await push.pushBackup(remote)
  const wd = join(root, 'backups', '.gitee')
  const urlOf = () => {
    const c = commands.filter((x) => x.args[0] === 'remote')
    const last = c[c.length - 1]
    return last.args.find((a) => a.startsWith('https://'))
  }
  // 换一个仓库（owner 不变）再推：remote 必须 set-url 成新仓库
  await push.pushBackup({ ...remote, repo: 'repo-y' })
  assert.equal(urlOf(), 'https://gitee.com/owner-x/repo-y.git')
  assert.equal(readGitConfig(wd).includes('SECRET_TOKEN_A1'), false)
  // 旧版写进 config 的明文令牌：检测到就清掉中转目录并报人话（自愈）
  rmSync(join(wd, '.git'), { recursive: true, force: true })
  mkdirSync(join(wd, '.git'), { recursive: true })
  writeFileSync(join(wd, '.git', 'config'), `[remote "origin"]\n\turl = https://oauth2:SECRET_TOKEN_A1@gitee.com/owner-x/repo-x.git\n`)
  await assert.rejects(push.pushBackup(remote), /残留了明文令牌/)
  assert.equal(existsSync(join(wd, '.git')), false, '带明文令牌的 .git 已被清掉')
})

test('git 没装时报「去装 git」而不是甩原始错误', async () => {
  fresh()
  backup('aurabot-backup-20261103-0330.zip')
  try {
    push.pushHooks.spawn = (cmd) => ({ stdout: { on() {} }, stderr: { on() {} }, on(ev, fn) { if (ev === 'error') setImmediate(() => fn(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))) } })
    await assert.rejects(push.pushBackup(remote), /没装 git/)
  } finally {
    push.pushHooks.spawn = fakeSpawn
  }
})

test('被 pre-receive 拒收时自动重置历史再推一次（autoCreate + 空仓场景）', async () => {
  fresh()
  backup('aurabot-backup-20261103-0330.zip')
  const realSpawn = push.pushHooks.spawn
  let inits = 0
  let pushes = 0
  push.pushHooks.spawn = (cmd, args, opts) => {
    const name = args[0]
    if (name === 'init') inits++
    if (name === 'push') {
      pushes++
      if (pushes === 1) return failChild('To https://gitee.com/x.git\n ! [remote rejected] HEAD -> master (pre-receive hook declined)')
    }
    return realSpawn(cmd, args, opts)
  }
  try {
    const r = await push.pushBackup(remote, { version: 'x' })
    assert.equal(r.ok, true)
    assert.equal(inits, 2) // 第二次 init = 历史被重置
    assert.equal(pushes, 2)
    assert.ok(commands.filter((c) => c.args[0] === 'commit').length >= 2)
    // 重试那次是 --force（新历史和远端对不上，必须覆盖）；第一次失败没走假 git 记录，唯一记录就是重试
    const pushesRecorded = commands.filter((c) => c.args[0] === 'push')
    assert.equal(pushesRecorded.length, 1)
    assert.ok(pushesRecorded[0].args.includes('--force'))
  } finally {
    push.pushHooks.spawn = realSpawn
  }
})

test('P1-5 force 保护：远端已有内容且没勾「允许覆盖」时，分叉不自动 --force，报错提示去面板勾', async () => {
  fresh()
  backup('aurabot-backup-20261103-0330.zip')
  const realSpawn = push.pushHooks.spawn
  push.pushHooks.spawn = (cmd, args, opts) => {
    if (args[0] === 'ls-remote') return childOf({ code: 0, out: 'abc123\trefs/heads/master\n' }) // 远端有内容
    if (args[0] === 'push') return failChild(' ! [rejected] master -> master (fetch first)')
    return realSpawn(cmd, args, opts)
  }
  try {
    await assert.rejects(push.pushBackup(remote), (e) => {
      assert.equal(String(e.message).includes('允许覆盖'), true)
      assert.equal(String(e.message).includes('SECRET_TOKEN_A1'), false)
      return true
    })
    assert.equal(commands.filter((c) => c.args[0] === 'push' && c.args.includes('--force')).length, 0, '没勾「允许覆盖」绝不 --force')
  } finally {
    push.pushHooks.spawn = realSpawn
  }
})

test('P1-5 force 保护：勾了「允许覆盖」后分叉会 --force 覆盖', async () => {
  fresh()
  backup('aurabot-backup-20261103-0330.zip')
  const realSpawn = push.pushHooks.spawn
  let pushes = 0
  push.pushHooks.spawn = (cmd, args, opts) => {
    if (args[0] === 'push') {
      pushes++
      if (pushes === 1) return failChild(' ! [rejected] master -> master (fetch first)')
    }
    return realSpawn(cmd, args, opts) // 第二次覆盖推送落回假 git（成功且被记录）
  }
  try {
    const r = await push.pushBackup({ ...remote, forceOverwrite: true }, { version: 'x' })
    assert.equal(r.ok, true)
    const forcePush = commands.filter((c) => c.args[0] === 'push' && c.args.includes('--force'))
    assert.equal(forcePush.length, 1)
  } finally {
    push.pushHooks.spawn = realSpawn
  }
})
test('P1-5 force 保护：远端已有内容时，pre-receive 拒收后的「重置历史重推」也不自动进行', async () => {
  fresh()
  backup('aurabot-backup-20261103-0330.zip')
  const realSpawn = push.pushHooks.spawn
  push.pushHooks.spawn = (cmd, args, opts) => {
    if (args[0] === 'ls-remote') return childOf({ code: 0, out: 'abc123\trefs/heads/master\n' })
    if (args[0] === 'push') return failChild(' ! [remote rejected] HEAD -> master (pre-receive hook declined)')
    return realSpawn(cmd, args, opts)
  }
  try {
    await assert.rejects(push.pushBackup(remote), (e) => {
      assert.ok(String(e.message).includes('允许覆盖'))
      return true
    })
    assert.equal(commands.filter((c) => c.args[0] === 'init').length, 1, '没有重置历史')
  } finally {
    push.pushHooks.spawn = realSpawn
  }
})
test('远端历史分叉时直接覆盖推送（备份仓以本地为准；autoCreate + 空仓场景）', async () => {
  fresh()
  backup('aurabot-backup-20261103-0330.zip')
  const realSpawn = push.pushHooks.spawn
  let pushes = 0
  push.pushHooks.spawn = (cmd, args, opts) => {
    if (args[0] === 'push') {
      pushes++
      if (pushes === 1) return failChild(' ! [rejected] master -> master (fetch first)')
    }
    return realSpawn(cmd, args, opts) // 第二次覆盖推送落回假 git（成功且被记录）
  }
  try {
    const r = await push.pushBackup(remote, { version: 'x' })
    assert.equal(r.ok, true)
    const pushesRecorded = commands.filter((c) => c.args[0] === 'push')
    assert.equal(pushesRecorded.length, 1)
    assert.ok(pushesRecorded[0].args.includes('--force'))
  } finally {
    push.pushHooks.spawn = realSpawn
  }
})

test('超过单文件上限自动分卷推送，卷放进日期文件夹，旧文件一起清', async () => {
  fresh()
  const zipName = 'aurabot-backup-20261103-0330.zip'
  const base = 'aurabot-backup-20261103-0330'
  const zipData = Buffer.alloc(2500, 7) // 2500B / 每卷 1000B = 3 卷
  mkdirSync(join(root, 'backups'), { recursive: true })
  writeFileSync(join(root, 'backups', zipName), zipData)
  commands = []
  push.pushHooks.splitMax = 1000
  try {
    const r = await push.pushBackup({ ...remote, keep: 3 }, { version: 'x' })
    assert.equal(r.parts, 3)
    assert.equal(r.folder, `backups/${base}`)
    assert.ok(r.message.includes('3 卷'))
    const outDir = join(root, 'backups', '.gitee', 'backups', base)
    assert.deepEqual(readdirSync(outDir).sort(), [`${zipName}.part01`, `${zipName}.part02`, `${zipName}.part03`])
    // 分卷内容拼回来要和原文件一致
    const full = Buffer.concat([
      readFileSync(join(outDir, `${zipName}.part01`)),
      readFileSync(join(outDir, `${zipName}.part02`)),
      readFileSync(join(outDir, `${zipName}.part03`)),
    ])
    assert.deepEqual([...full], [...zipData])
  } finally {
    push.pushHooks.splitMax = null
  }
})

test('旧版平铺的 zip/分卷自动迁进日期文件夹', async () => {
  fresh()
  const wd = join(root, 'backups', '.gitee')
  mkdirSync(wd, { recursive: true })
  writeFileSync(join(wd, 'aurabot-backup-20261102-0330.zip'), 'old-full')
  writeFileSync(join(wd, 'aurabot-backup-20261101-0330.zip.part01'), 'old-p1')
  backup('aurabot-backup-20261103-0330.zip')
  const r = await push.pushBackup({ ...remote, keep: 3 }, { version: 'x' })
  assert.equal(r.ok, true)
  const ar = join(wd, 'backups')
  assert.equal(existsSync(join(ar, 'aurabot-backup-20261102-0330', 'aurabot-backup-20261102-0330.zip')), true)
  assert.equal(existsSync(join(ar, 'aurabot-backup-20261101-0330', 'aurabot-backup-20261101-0330.zip.part01')), true)
  assert.equal(existsSync(join(ar, 'aurabot-backup-20261103-0330', 'aurabot-backup-20261103-0330.zip')), true)
  assert.equal(readdirSync(wd).filter((n) => n.endsWith('.zip') || n.includes('.part')).length, 0, '平铺文件都挪走了')
})
