// 自驱引擎 · Python（P3，docs/AUTOTELIC-PLAN.md §1.2 / §3 P3.3~P3.7）。
//
// 铁律：不许写死解释器名。运行时探测，滤掉三类假货：
//   ① Microsoft Store 0 字节占位别名（跑不出 Python 3.x 版本串）
//   ② 能启动但不是 Python 的
//   ③ 版本 < 3 的
// 探测结果缓存 env.json（不带模块名前缀，api.dataDir 已自带）；每次启动重新校验。
// 没装 Python = 这一项能力不可用，其余照常（优雅降级）。
// 跑脚本：子进程 + 超时击杀 + 不继承插件的敏感环境变量（白名单 env）。

import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson } from '../core/store.js'

const PROBE_ORDER = ['python', 'py', 'python3', 'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3.9']

/** 子进程跑一下 `<bin> --version`（测试可注入 fake run）。 */
function probeRun(bin, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try { child = spawn(bin, ['--version'], { windowsHide: true }) } catch (error) { return resolve({ code: -1, out: String(error?.message || error) }) }
    let out = ''
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeoutMs)
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { out += d })
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, out: String(error?.message || error) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out }) })
  })
}

/** 假货过滤：WindowsApps 下的 0 字节占位别名（本机实测 python3 就是这种）。 */
function isStorePlaceholder(bin) {
  try {
    if (!/windowsapps/i.test(bin)) return false
    const st = statSync(bin)
    return st.isFile() && st.size === 0
  } catch { return false }
}

const VERSION_RE = /Python\s+(\d+)\.(\d+)\.(\d+)/

/**
 * 探测一个候选。返回 {bin, version} 或 null。
 * @param {object} o
 * @param {(bin:string, timeoutMs?:number)=>Promise<{code:number,out:string}>} [o.run] 注入点（测试用 fake）
 * @param {number} [o.timeoutMs]
 */
export async function probeOne(bin, { run = probeRun, timeoutMs = 8000 } = {}) {
  if (isStorePlaceholder(bin)) return null // ① 0 字节占位
  const r = await run(bin, timeoutMs)
  if (r.code !== 0) return null // ② 起不来的（含商店别名唤起 Store 的失败）
  const m = VERSION_RE.exec(r.out || '')
  if (!m) return null // ② 不是 Python
  const major = Number(m[1])
  if (major < 3) return null // ③ 版本过低
  return { bin, version: `${m[1]}.${m[2]}.${m[3]}` }
}

/**
 * 全量探测（§1.2 顺序：配置优先 → 常见名字逐个试）。
 * @returns {{pythonBin:string, version:string, probedAt:number}|null} null = 本机没有可用 Python
 */
export async function probePython({ configured = '', run = probeRun, timeoutMs = 8000 } = {}) {
  const first = String(configured || '').trim()
  const order = first ? [first, ...PROBE_ORDER.filter((b) => b !== first)] : PROBE_ORDER
  for (const bin of order) {
    const hit = await probeOne(bin, { run, timeoutMs })
    // 字段名统一叫 pythonBin（envUsable / 面板 / 跑脚本工具都读它）；bin 保留给旧测试。
    if (hit) return { pythonBin: hit.bin, ...hit, probedAt: Date.now() }
  }
  return null
}

/** env.json 缓存（api.dataDir('env.json')）：启动时读，失效重新探测。
 *  兼容旧缓存：早期版本写的是 {bin,version}，统一迁到 pythonBin。 */
export function loadEnvCache(file) {
  const env = readJson(file, null)
  if (env && env.bin && !env.pythonBin) env.pythonBin = env.bin
  return env
}
export function saveEnvCache(file, env) { if (env) writeJson(file, env); else { try { writeJson(file, { pythonBin: '', version: '', probedAt: Date.now(), unavailable: true }) } catch {} } }

/** env 缓存还有效吗：探测过且在 24h 内 → 有效（路径被卸载这种极端情况由跑脚本时的失败兜底）。 */
export function envUsable(env, now = Date.now()) {
  return Boolean(env && env.pythonBin && !env.unavailable && now - (env.probedAt || 0) < 24 * 3600_000)
}

/** 子进程白名单 env：不带插件的任何敏感变量（API key / cookie / token 一律不继承）。 */
export function cleanEnv(base = process.env) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']
  const out = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  for (const k of keep) if (base[k]) out[k] = base[k]
  return out
}

const clip = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n) + '…' : t }

/**
 * 跑一段 Python 脚本（P3.4~P3.7）。
 * 脚本落 <dir>/scripts，产物/输出落 <dir>/out；超时击杀；敏感 env 不继承。
 * @param {object} o
 * @param {string} o.dir 模块数据目录（api.dataDir()）
 * @param {string} o.pythonBin 已探测的解释器
 * @param {string} o.code 脚本源码
 * @param {number} [o.timeoutMs]
 * @param {(bin:string, args:string[], opts:object)=>object} [o.spawnFn] 注入点（测试用）
 * @returns {{ok:boolean, stdout:string, stderr:string, file:string, ms:number, timedOut?:boolean, error?:string}}
 */
export function runPython({ dir, pythonBin, code, timeoutMs = 120000, argv = [], spawnFn = spawn } = {}) {
  if (!pythonBin) return { ok: false, error: '没有可用的 Python（面板「自驱引擎」页可手动填路径）' }
  if (typeof code !== 'string' || !code.trim()) return { ok: false, error: '脚本是空的' }
  if (code.length > 256 * 1024) return { ok: false, error: '脚本太大（>256KB）' }
  const started = Date.now()
  const file = join(dir, 'scripts', `py-${started}-${Math.floor(Math.random() * 1e6)}.py`)
  try { mkdirSync(join(dir, 'scripts'), { recursive: true }); mkdirSync(join(dir, 'out'), { recursive: true }); writeFileSync(file, code, 'utf8') } catch (error) {
    return { ok: false, error: `脚本写不了：${error?.message || error}` }
  }
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn(pythonBin, [file, ...argv], { cwd: join(dir, 'out'), env: cleanEnv(), windowsHide: true })
    } catch (error) {
      return resolve({ ok: false, error: `起不来：${error?.message || error}`, file, ms: Date.now() - started })
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { child.kill('kill') } catch {} }, Math.max(200, timeoutMs))
    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', (d) => { stderr += d })
    child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, error: String(error?.message || error), file, ms: Date.now() - started, stdout: clip(stdout, 8000), stderr: clip(stderr, 8000) }) })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      // 落一份输出（stdout 为主；产物约定写 out/ 目录，脚本自己负责）
      try { if (stdout.trim()) writeFileSync(join(dir, 'out', `out-${started}.txt`), stdout, 'utf8') } catch {}
      resolve({
        ok: !timedOut && exitCode === 0,
        timedOut,
        exitCode: exitCode ?? -1,
        stdout: clip(stdout, 8000),
        stderr: clip(stderr, 4000),
        file,
        ms: Date.now() - started,
        ...(timedOut ? { error: `脚本超时被杀（>${timeoutMs}ms，场景 19）` } : exitCode !== 0 ? { error: `退出码 ${exitCode}` } : {}),
      })
    })
  })
}
