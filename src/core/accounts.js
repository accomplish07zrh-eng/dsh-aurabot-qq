// 账号注册表：一个 Aurabot 插件实例下可以有多个 QQ 号。
// 默认账号沿用老目录（plugins-data/aurabot/），新账号放 accounts/<id>/。
// 这里只管账号的元数据和配置初始化；运行时的 OneBot/SnowLuma 由 host 按账号启动。

import { mkdirSync, existsSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { baseDataDir, accountDir, withAccount, readJson, writeJson, ensureDir } from './store.js'
import { loadConfig, saveConfig, DEFAULTS } from './config.js'

const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

const accountsFile = () => baseDataDir('accounts.json')
const defaultAccount = () => ({ id: 'default', name: '若娜瓦', enabled: true, createdAt: 0, primary: true, slot: 'aurabot' })

export function normalizeAccountId(raw) {
  const id = String(raw || '').trim().toLowerCase()
  return ACCOUNT_RE.test(id) ? id : ''
}

export function loadAccounts() {
  const raw = readJson(accountsFile(), null)
  const list = Array.isArray(raw?.accounts) ? raw.accounts : []
  const out = []
  const seen = new Set()
  for (const item of list) {
    const id = normalizeAccountId(item?.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: String(item.name || id), enabled: item.enabled !== false, locked: id === 'default' ? true : Boolean(item.locked), createdAt: Number(item.createdAt) || 0, primary: false, slot: String(item.slot || (id === 'default' ? 'aurabot' : '')) })
  }
  if (!seen.has('default')) out.unshift(defaultAccount())
  else out.sort((a, b) => (a.id === 'default' ? -1 : b.id === 'default' ? 1 : 0))
  return out
}

export function saveAccounts(accounts) {
  const list = (Array.isArray(accounts) ? accounts : []).map((a) => ({
    id: normalizeAccountId(a.id) || 'default',
    name: String(a.name || a.id || 'default'),
    enabled: a.enabled !== false,
    locked: Boolean(a.locked),
    createdAt: Number(a.createdAt) || 0,
    slot: String(a.slot || (a.id === 'default' ? 'aurabot' : '')),
  }))
  writeJson(accountsFile(), { accounts: list })
  return loadAccounts()
}

/** 某个账号的配置路径（默认账号仍在根目录，老数据不用迁移）。 */
export function accountConfigPath(id = 'default') {
  return join(accountDir(id), 'config.json')
}

export function loadConfigFor(id = 'default') {
  return withAccount(id, () => loadConfig())
}

export function saveConfigFor(id, cfg) {
  return withAccount(id, () => saveConfig(cfg))
}

/**
 * 新建账号：直接复制默认账号的初始配置，清掉 QQ/SnowLuma/密钥；模块走默认设置。
 */
function generateAccountId(accounts) {
  for (let i = 0; i < 50; i++) {
    const id = 'acc-' + randomBytes(4).toString('hex')
    if (!accounts.some((a) => a.id === id)) return id
  }
  throw new Error('生成账号 id 失败，请重试')
}

export function createAccount({ id, name, persona } = {}) {
  const accounts0 = loadAccounts()
  const accountId = id ? normalizeAccountId(id) : generateAccountId(accounts0)
  if (!accountId || accountId === 'default') throw new Error('账号 id 只能用小写字母/数字/短横线，且不能叫 default')
  if (/^\d{5,12}$/.test(accountId)) throw new Error('账号 id 不能用 QQ 号，QQ 放在 config.botQQ 里')
  const accounts = accounts0
  if (accounts.some((a) => a.id === accountId)) throw new Error(`账号 ${accountId} 已经存在`)

  const template = withAccount('default', () => loadConfig())
  // 新实例从插件默认配置开始，只继承主人的身份和权限；模型/语音/平台登录等一律用默认值。
  const cfg = JSON.parse(JSON.stringify(DEFAULTS))
  for (const k of ['ownerQQ', 'ownerName', 'ownerLevel', 'approvalNotify', 'approvalViaQQ', 'profilePerms', 'qqApi', 'longTasks', 'subagentBackground']) {
    if (template[k] !== undefined) cfg[k] = JSON.parse(JSON.stringify(template[k]))
  }
  cfg.enabled = false
  cfg.dryRun = true
  cfg.setupDone = false
  cfg.botQQ = ''
  cfg.snowluma = {
    ...JSON.parse(JSON.stringify(DEFAULTS.snowluma)),
    webuiPort: 5100,
    dir: String(template.snowluma?.dir || ''),
    autoStart: false,
    autoAttach: false,
    webuiPassword: String(template.snowluma?.webuiPassword || ''),
    passwordAuto: false,
    httpUrl: '',
    wsUrl: '',
    httpToken: '',
    wsToken: '',
  }
  cfg.bridge = { ...DEFAULTS.bridge, token: '' }
  cfg.workspaceDir = ''
  cfg.persona = { ...(cfg.persona || {}), current: String(persona || 'dafeiyu') }
  cfg.modules = JSON.parse(JSON.stringify(DEFAULTS.modules || {}))

  ensureDir(accountDir(accountId))
  try {
    const dstDir = join(accountDir(accountId), 'personas')
    mkdirSync(dstDir, { recursive: true })
    copyFileSync(new URL('../../personas/dafeiyu.md', import.meta.url), join(dstDir, 'dafeiyu.md'))
  } catch (error) {}
  withAccount(accountId, () => saveConfig(cfg))
  const used = new Set(accounts.map((a) => a.slot).filter(Boolean))
  let slot = 'aurabot'
  if (used.has(slot)) {
    let n = 2
    while (used.has("aurabot-" + n)) n++
    slot = "aurabot-" + n
  }
  const slotNo = Math.max(1, Number(String(slot).split('-')[1] || 1))
  // SnowLuma 是同一个进程管多个 QQ；新账号只接入，不自己再拉一个进程。
  cfg.snowluma = { ...(cfg.snowluma || {}), autoStart: false }
  withAccount(accountId, () => saveConfig(cfg))
  const settingsPath = join(accountDir(accountId), 'modules-data', 'persona-memory', 'settings.json')
  if (!existsSync(settingsPath)) {
    try {
      mkdirSync(join(accountDir(accountId), 'modules-data', 'persona-memory'), { recursive: true })
      writeFileSync(settingsPath, JSON.stringify({ serviceUrl: `http://127.0.0.1:${19092 + slotNo - 1}` }, null, 2), 'utf8')
    } catch (error) {}
  }
  const next = [...accounts, { id: accountId, name: String(name || accountId), enabled: false, createdAt: Date.now(), slot }]
  saveAccounts(next)
  return { account: loadAccounts().find((a) => a.id === accountId), config: cfg }
}



