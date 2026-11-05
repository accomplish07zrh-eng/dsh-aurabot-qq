// 数据目录、JSON 读写（UTF-8 无 BOM、先写临时文件再改名）。

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * 当前实例名。一个 DSH 里可以同时跑多个 Aurabot 实例（多个 QQ 号），
 * 每个实例有自己的数据目录、路由前缀和定时器名。
 * 宿主在 apply() 最开头调用 setInstance() 定下来；不调就是默认的 aurabot。
 */
let INSTANCE = 'aurabot'
export function setInstance(id) {
  const name = String(id || '').trim()
  INSTANCE = name && /^[\w.-]+$/.test(name) ? name : 'aurabot'
}
export function instanceName() {
  return INSTANCE
}

const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const accountStorage = new AsyncLocalStorage()
export function normalizeAccount(id) {
  const name = String(id || '').trim().toLowerCase()
  return ACCOUNT_RE.test(name) ? name : 'default'
}
/** 在某个账号的上下文里跑一段异步逻辑；dataDir 会跟着走。 */
export function withAccount(id, fn) {
  return accountStorage.run(normalizeAccount(id), fn)
}
export function currentAccount() {
  return accountStorage.getStore() || normalizeAccount(process.env.AURABOT_ACCOUNT)
}

/** 插件数据根目录（不区分账号）。 */
export function baseDataDir(...parts) {
  const base = process.env.AURABOT_DATA_DIR || join(dshHome(), 'plugins-data', INSTANCE)
  return join(base, ...parts)
}

/** 账号数据目录：默认账号沿用老目录，其他账号放 accounts/<id>/。 */
export function accountDir(id = currentAccount()) {
  const account = normalizeAccount(id)
  const base = baseDataDir()
  return account === 'default' ? base : join(base, 'accounts', account)
}

/** 当前账号的数据目录；默认账号路径与老版本完全一致。 */
export function dataDir(...parts) {
  return join(accountDir(), ...parts)
}


export function ensureDir(p) {
  mkdirSync(p, { recursive: true })
  return p
}

export function readJson(file, fallback) {
  try {
    let text = readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return JSON.parse(text)
  } catch (error) {
    return typeof fallback === 'function' ? fallback() : fallback
  }
}

export function writeJson(file, value) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

export { existsSync }
