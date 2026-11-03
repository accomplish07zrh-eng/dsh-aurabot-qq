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
const fakeSpawn = (cmd, args, { cwd }) => {
  const name = args[0]
  commands.push({ cmd, args, cwd })
  if (failOn === name && name !== 'init') return failChild(`remote: fatal error on ${name}`)
  if (name === 'init') { mkdirSync(join(cwd, '.git'), { recursive: true }); return okChild() }
  return okChild()
}

before(async () => {
  process.env.AURABOT_DATA_DIR = root
  push = await import('../src/core/backup-push.js')
  push.pushHooks.spawn = fakeSpawn
  push.pushHooks.fetch = async () => ({ ok: true, status: 201 })
})

after(() => rmSync(root, { recursive: true, force: true }))

const remote = { owner: 'owner-x', repo: 'repo-x', token: 'SECRET_TOKEN_A1', branch: 'master', keep: 2, autoCreate: true }
const putZip = (name) => writeFileSync(join(root, 'backups', name), name)
const backup = (n) => { mkdirSync(join(root, 'backups'), { recursive: true }); putZip(n) }

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

test('完整推送：init → remote → ls-remote → add → commit → push（首次中转目录是空的，没有旧的可清）', async () => {
  backup('aurabot-backup-20261101-0330.zip')
  backup('aurabot-backup-20261102-0330.zip')
  backup('aurabot-backup-20261103-0330.zip')
  commands = []
  const r = await push.pushBackup(remote, { version: '1.2.0' })
  assert.equal(r.ok, true)
  assert.equal(r.name, 'aurabot-backup-20261103-0330.zip')
  assert.equal(r.kept, 1)
  assert.equal(r.dropped, 0)
  const names = commands.map((c) => c.args[0])
  assert.deepEqual(names, ['init', 'remote', 'ls-remote', 'add', 'commit', 'push'])
  const pushArgs = commands.find((c) => c.args[0] === 'push').args
  assert.ok(pushArgs.includes('HEAD:master'))
  const urlArg = commands.find((c) => c.args[0] === 'remote').args.find((a) => a.startsWith('https://'))
  assert.ok(urlArg.includes('oauth2:SECRET_TOKEN_A1@gitee.com/owner-x/repo-x.git'))
  // 工作目录在 backups/.gitee（数据目录内、不进备份）；归档结构：backups/<日期文件夹>/<zip>
  assert.equal(r.folder, 'backups/aurabot-backup-20261103-0330')
  assert.equal(readFileSync(join(root, 'backups', '.gitee', 'backups', 'aurabot-backup-20261103-0330', r.name), 'utf8'), r.name)
})

test('第二次推送会清掉旧备份文件夹（远端跟着清，keep=1 只留最新）', async () => {
  backup('aurabot-backup-20261104-0330.zip')
  commands = []
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

test('没备份文件时给人话', async () => {
  rmSync(join(root, 'backups'), { recursive: true, force: true })
  await assert.rejects(push.pushBackup(remote), /还没有备份文件/)
  backup('aurabot-backup-20261103-0330.zip')
})

test('仓库不存在时自动建一个私有的，然后接着推', async () => {
  rmSync(join(root, 'backups', '.gitee'), { recursive: true, force: true })
  const realSpawn = push.pushHooks.spawn
  let bodies = []
  push.pushHooks.fetch = async (url, init) => {
    bodies.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 201 }
  }
  push.pushHooks.spawn = (cmd, args, opts) => {
    // 第一次 ls-remote 说仓库不存在（触发自动建），建完后再查就当仓库在了
    if (args[0] === 'ls-remote') return bodies.length === 0 ? failChild('remote: Repository not found', 128) : okChild()
    return realSpawn(cmd, args, opts)
  }
  const r = await push.pushBackup(remote)
  assert.equal(r.ok, true)
  assert.deepEqual(bodies[0], { url: 'https://gitee.com/api/v5/user/repos', body: { access_token: 'SECRET_TOKEN_A1', name: 'repo-x', private: true, auto_init: false } })
})

test('git 没装时报「去装 git」而不是甩原始错误', async () => {
  rmSync(join(root, 'backups', '.gitee'), { recursive: true, force: true })
  const saved = push.pushHooks.spawn
  try {
    push.pushHooks.spawn = (cmd) => ({ stdout: { on() {} }, stderr: { on() {} }, on(ev, fn) { if (ev === 'error') setImmediate(() => fn(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))) } })
    await assert.rejects(push.pushBackup(remote), /没装 git/)
  } finally {
    push.pushHooks.spawn = fakeSpawn // 别把 ENOENT 桩漏给后面的用例
    void saved
  }
})

test('被 pre-receive 拒收时自动重置历史再推一次', async () => {
  rmSync(join(root, 'backups', '.gitee'), { recursive: true, force: true })
  const realSpawn = push.pushHooks.spawn
  let inits = 0
  let pushes = 0
  commands = [] // 这个用例自己数命令，别把前面用例的记录算进来
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

test('远端历史分叉时直接覆盖推送（备份仓以本地为准）', async () => {
  rmSync(join(root, 'backups', '.gitee'), { recursive: true, force: true })
  const realSpawn = push.pushHooks.spawn
  let inits = 0
  let pushes = 0
  commands = []
  push.pushHooks.spawn = (cmd, args, opts) => {
    const name = args[0]
    if (name === 'init') inits++
    if (name === 'push') {
      pushes++
      if (pushes === 1) return failChild('To https://gitee.com/x.git\n ! [rejected] master -> master (fetch first)')
    }
    return realSpawn(cmd, args, opts)
  }
  try {
    const r = await push.pushBackup(remote, { version: 'x' })
    assert.equal(r.ok, true)
    assert.equal(inits, 1, '非快进不用重置历史')
    const pushesRecorded = commands.filter((c) => c.args[0] === 'push')
    assert.equal(pushesRecorded.length, 1)
    assert.ok(pushesRecorded[0].args.includes('--force'))
  } finally {
    push.pushHooks.spawn = realSpawn
  }
})

test('超过单文件上限自动分卷推送，卷放进日期文件夹，旧文件一起清', async () => {
  rmSync(join(root, 'backups', '.gitee'), { recursive: true, force: true })
  push.pushHooks.spawn = fakeSpawn // 恢复假 git
  const zipName = 'aurabot-backup-20261103-0330.zip'
  const base = 'aurabot-backup-20261103-0330'
  mkdirSync(join(root, 'backups'), { recursive: true })
  writeFileSync(join(root, 'backups', zipName), Buffer.alloc(2500, 7)) // 2500B / 每卷 1000B = 3 卷
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
    assert.deepEqual([...full], [...readFileSync(join(root, 'backups', zipName))])
  } finally {
    push.pushHooks.splitMax = null
  }
})

test('旧版平铺的 zip/分卷自动迁进日期文件夹', async () => {
  rmSync(join(root, 'backups', '.gitee'), { recursive: true, force: true })
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
