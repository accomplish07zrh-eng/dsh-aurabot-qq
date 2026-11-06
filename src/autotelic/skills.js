// 自驱引擎 · 技能库 + 用户模块写入（P3.1/P3.2 + P4.2，docs/AUTOTELIC-PLAN.md §3）。
//
// 技能库（P4.2）：skills/<id>/manifest.json。判定口径（少爷定的）：
//   同一技能连续复现 2 次成功 → learned；失败 3 次 → 从候选降级为 retired（learned 的降回 candidate）。
// 技能本体是「一段 Python 脚本 + 保存它的目的」——执行走 runPython（子进程隔离），
// 不做进程内 import（P4.3 的子智能体隔离需要 plugin-internals + subagentBackground，本期未开，见模块壳注释）。
//
// 用户模块（P3.1）：写 plugins-data/aurabot/modules/<id>/index.mjs，插件自己的 3 秒 watcher 自动热加载。
// 写前校验：id 合法 + 必须有 export default + 体积上限。诚实的边界（§1.1）：
//   同名替换写坏了回退内置；新 id 写坏了只是这个模块不可用（面板「已安装」报错，需人工清理）——
//   这里没有魔法回退，别给她虚假的安全感。

import { mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson } from '../core/store.js'

const ID_RE = /^[a-z][a-z0-9-]{1,39}$/
const MAX_CODE = 256 * 1024

/** 技能库。dir = api.dataDir()（skills/ 落在它下面）。 */
export function createSkills(dir) {
  const fileOf = (id) => join(dir, 'skills', id, 'manifest.json')

  /** 保存（新建立即写）一个技能候选；已存在则更新标题与脚本并回到候选（重学）。 */
  function save({ id, title = '', script }) {
    const key = String(id || '').trim()
    if (!ID_RE.test(key)) return { ok: false, why: `技能 id「${key}」不对：小写字母开头，小写字母/数字/-，2~40 字` }
    if (typeof script !== 'string' || !script.trim()) return { ok: false, why: '脚本是空的' }
    if (script.length > MAX_CODE) return { ok: false, why: '脚本太大（>256KB）' }
    const prev = readJson(fileOf(key), null)
    const manifest = {
      id: key,
      title: String(title || prev?.title || key).slice(0, 80),
      script,
      status: 'candidate', // candidate → learned；降级见 recordRun
      streak: { ok: 0, fail: 0 },
      runs: (prev?.runs || []).slice(-40),
      createdAt: prev?.createdAt || Date.now(),
      updatedAt: Date.now(),
    }
    try { mkdirSync(join(dir, 'skills', key), { recursive: true }); writeJson(fileOf(key), manifest) } catch (error) {
      return { ok: false, why: `写不了：${error?.message || error}` }
    }
    return { ok: true, manifest }
  }

  function get(id) { return readJson(fileOf(String(id || '').trim()), null) }

  /**
   * 记一次运行结果（场景 12）：连续 2 次成功才 learned；失败 3 次降级（candidate→retired，learned→candidate）。
   * @returns {{status:string, changed:boolean, why?:string}}
   */
  function recordRun(id, ok) {
    const key = String(id || '').trim()
    const m = get(key)
    if (!m) return { status: 'missing', changed: false, why: '没有这个技能' }
    m.runs = [...(m.runs || []), { at: Date.now(), ok: Boolean(ok) }].slice(-40)
    m.streak = m.streak || { ok: 0, fail: 0 }
    if (ok) {
      m.streak.ok += 1
      m.streak.fail = 0
      if (m.status === 'retired') m.status = 'candidate' // 重学从候选开始
      if (m.streak.ok >= 2 && m.status === 'candidate') { m.status = 'learned'; m.why = `连续复现 ${m.streak.ok} 次成功，算学会了` }
    } else {
      m.streak.fail += 1
      m.streak.ok = 0
      if (m.status === 'learned' && m.streak.fail >= 3) { m.status = 'candidate'; m.why = '连续失败 3 次，降回候选' }
      else if (m.status === 'candidate' && m.streak.fail >= 3) { m.status = 'retired'; m.why = '连续失败 3 次，退役（想重学就重新保存）' }
    }
    m.updatedAt = Date.now()
    try { writeJson(fileOf(key), m) } catch (error) { return { status: m.status, changed: false, why: error?.message } }
    return { status: m.status, changed: true, why: m.why }
  }

  function list() {
    const out = []
    try {
      for (const d of readdirSync(join(dir, 'skills'))) {
        const m = get(d)
        if (m) out.push({ id: m.id, title: m.title, status: m.status, streak: m.streak, runs: (m.runs || []).length, updatedAt: m.updatedAt })
      }
    } catch { /* 还没有技能目录 */ }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }

  return { save, get, recordRun, list }
}

/**
 * 写用户模块（P3.1/P3.2）。dir = 用户模块根目录（plugins-data/aurabot/modules）。
 * 写入成功后由插件的 3 秒 watcher 自动热加载——这里不主动 reload（watcher 是唯一加载通道，别抢）。
 * @returns {{ok:boolean, why?:string, file?:string, note?:string}}
 */
export function writeUserModule({ dir, id, code }) {
  const key = String(id || '').trim()
  if (!ID_RE.test(key)) return { ok: false, why: `模块 id「${key}」不对：小写字母开头，小写字母/数字/-，2~40 字` }
  if (typeof code !== 'string' || !code.includes('export default')) return { ok: false, why: '入口文件必须 export default 一个模块对象（照面板「模块市场→模板」的样子写）' }
  if (code.length > MAX_CODE) return { ok: false, why: '模块太大（>256KB）' }
  if (/from\s+['"](\.\.\/)+/.test(code)) return { ok: false, why: '不许 import 用户模块目录外面的东西（写不到框架，src/ 对她锁死）' }
  const file = join(dir, key, 'index.mjs')
  try {
    mkdirSync(join(dir, key), { recursive: true })
    writeFileSync(file, code, 'utf8')
  } catch (error) {
    return { ok: false, why: `写不了：${error?.message || error}` }
  }
  return {
    ok: true,
    file,
    // 诚实的边界（§1.1）：新 id 没有同名内置兜底——写坏了就是这个模块不可用，面板报错，要人工清理
    note: '几秒后自动热加载；同名内置被替换时写坏了会回退内置，全新 id 写坏了只是这个模块不可用（面板「已安装」看报错）',
  }
}
