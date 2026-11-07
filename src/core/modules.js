// 模块内核：插件的功能都是模块，内置的在 src/modules/，自己写的放数据目录 modules/（升级不会动）。
//
// - 每个模块能单独开关；自己写的模块和内置的同名，就替换掉内置的
// - 模块之间用 api.use('模块id') 拿对方导出的东西，用的时候再拿（对方被关了、换了也不会拿到旧的）
// - 模块注册的工具、上下文、命令、定时任务、面板接口都记在模块名下，关掉 / 重新加载时一起撤掉
// - 一个模块出错只影响它自己：启动失败记下原因，其他照常跑
// - 自己写的模块保存就生效（按修改时间重新加载），不用重启 DSH
//
// 接口说明给写模块的人看：src/modules/API.md（每次启动复制到数据目录 modules/ 里）。

import { existsSync, readdirSync, statSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, relative, resolve, sep, isAbsolute } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dataDir } from './store.js'
import { registerSecretField } from './config.js'
import { defineTool } from '../tools/tools.js'
import { selfName } from '../persona/personas.js'

/** 扩展接口版本：只加不改。哪天不得不改已有的东西才升到 2，并在更新说明里写清楚怎么迁移。 */
export const API_VERSION = 1
export const MIN_API_VERSION = 1

const SRC = fileURLToPath(new URL('../', import.meta.url)) // 插件的 src/
const BUILTIN_DIR = join(SRC, 'modules')
/** 内置模块目录（社区安装时判断会不会替换内置用）。 */
export const builtinDir = () => BUILTIN_DIR
const ID_RE = /^[a-z][a-z0-9-]{1,39}$/
const ENTRY = ['index.mjs', 'index.js']
const DOC = 'API.md'
const TYPES = 'aurabot.d.ts'
// 从内置搬到社区库的模块：接口路径不变，面板页照常能用
const STABLE_ROUTES = new Set(['pet', 'douyin', 'heybox', 'group-admin'])

export const userDir = () => dataDir('modules')

/** 内部源码全部按「相对 src 的路径」开放出来：lib('features/memory.js') → 那个文件导出的全部东西。 */
const libCache = new Map()
export async function loadLib() {
  if (libCache.size) return libCache
  const files = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) { if (!['templates', 'separator', '_template'].includes(e.name)) walk(full) }
      else if (e.name.endsWith('.js')) files.push(full)
    }
  }
  walk(SRC)
  for (const f of files) {
    const key = relative(SRC, f).split(sep).join('/')
    try { libCache.set(key, await import(pathToFileURL(f).href)) } catch (error) {}
  }
  return libCache
}
export function lib(key) {
  const k = String(key || '').replace(/^\.?\/?(src\/)?/, '')
  const hit = libCache.get(k) || libCache.get(k + '.js')
  if (!hit) throw new Error(`没有 ${key} 这个内部文件（看 API.md 的「内部源码」一节）`)
  return hit
}
export const libKeys = () => [...libCache.keys()].sort()

// 加载自己写的模块时跳过的目录：依赖、加载快照、版本库
const SKIP_DIRS = new Set(['node_modules', '.aurabot-cache', '.git'])
const SNAP = '.aurabot-cache'

/** 模块文件夹里所有文件（含子目录，不含依赖和快照）。 */
function filesOf(dir, base = dir, out = []) {
  let list = []
  try { list = readdirSync(dir, { withFileTypes: true }) } catch (error) { return out }
  for (const e of list) {
    const full = join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) filesOf(full, base, out) }
    else if (e.isFile()) out.push(relative(base, full))
  }
  return out
}

/** 模块的「版本戳」：任何文件改了、加了、删了都会变。 */
function stampOf(dir) {
  let t = 0
  const files = filesOf(dir)
  for (const f of files) { try { t = Math.max(t, statSync(join(dir, f)).mtimeMs) } catch (error) {} }
  return Math.round(t) + files.length / 1000
}
const entryOf = (dir) => ENTRY.map((n) => join(dir, n)).find((p) => existsSync(p)) || ''

/** 数据目录 modules/ 里有哪些模块（目录名以 _ 或 . 开头的跳过）：[{ id, dir, file }] */
export function scanUser() {
  const out = []
  let names = []
  try { names = readdirSync(userDir(), { withFileTypes: true }) } catch (error) { return out }
  for (const e of names) {
    if (!e.isDirectory() || /^[_.]/.test(e.name)) continue
    const dir = join(userDir(), e.name)
    const file = entryOf(dir)
    if (file) out.push({ id: e.name, dir, file })
  }
  return out
}

/** 检查模块定义，返回出错原因（没问题返回空串）。 */
export function checkDef(def, id) {
  if (!def || typeof def !== 'object') return '入口文件要 export default 一个对象（看 API.md）'
  if (typeof def.setup !== 'function') return '模块里没有 setup(api) 函数'
  if (!ID_RE.test(String(def.id || ''))) return `模块 id「${def.id ?? ''}」不对：小写字母开头，只能有小写字母、数字和 -，2~40 个字`
  if (id && def.id !== id) return `模块 id「${def.id}」要和文件夹名「${id}」一样`
  const want = Number(def.api ?? 1)
  if (want > API_VERSION) return `这个模块要扩展接口 v${want}，现在的插件只有 v${API_VERSION}，先更新插件`
  if (want < MIN_API_VERSION) return `这个模块是按扩展接口 v${want} 写的，现在最低支持 v${MIN_API_VERSION}，按更新说明改一下`
  return ''
}

/** 把一份源码里指向插件内部的相对 import 改成走 lib()，这样复制出去也能跑。 */
export function rewriteImports(code, fromKey, keep = new Set()) {
  const base = fromKey.split('/').slice(0, -1)
  const target = (spec) => {
    if (!/^\.\.?\//.test(spec)) return null
    const parts = [...base]
    for (const seg of spec.split('/')) {
      if (seg === '..') parts.pop()
      else if (seg !== '.') parts.push(seg)
    }
    const key = parts.join('/')
    return keep.has(key) ? null : key
  }
  const names = (list) => list.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\s+as\s+/, ': ')).join(', ')
  let out = code.replace(/import\s+(\w+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?/g, (m, def, list, spec) => {
    const key = target(spec)
    if (!key) return m
    const d = def ? `const ${def.replace(/[\s,]/g, '')} = __lib('${key}').default\n` : ''
    return `${d}const { ${names(list)} } = __lib('${key}')`
  })
  out = out.replace(/import\s+\*\s+as\s+(\w+)\s+from\s*['"]([^'"]+)['"];?/g, (m, name, spec) => {
    const key = target(spec)
    return key ? `const ${name} = __lib('${key}')` : m
  })
  out = out.replace(/import\s+(\w+)\s+from\s*['"]([^'"]+)['"];?/g, (m, name, spec) => {
    const key = target(spec)
    return key ? `const ${name} = __lib('${key}').default` : m
  })
  out = out.replace(/import\(\s*['"]([^'"]+)['"]\s*\)/g, (m, spec) => {
    const key = target(spec)
    return key ? `Promise.resolve(__lib('${key}'))` : m
  })
  // 插件里带的数据文件（new URL('./x.py', import.meta.url)）：指回插件目录
  out = out.replace(/new URL\(\s*['"](\.\.?\/[^'"]*)['"]\s*,\s*import\.meta\.url\s*\)/g, (m, spec) => {
    const key = target(spec)
    return key ? `new URL('${key}', globalThis.aurabot.src)` : m
  })
  if (out !== code) out = "const __lib = globalThis.aurabot.lib // 插件内部源码（复制出来后靠它找到插件里的文件）\n" + out
  return out
}

/**
 * @param {object} o
 * @param {object} o.ctx        DSH 给插件的 ctx
 * @param {object} o.core       核心对象（hub、onebot、snowluma、local……），模块通过 api.core 拿到
 * @param {Function} o.getConfig
 * @param {Function} o.setConfig
 * @param {object} o.logger
 * @param {string} o.version     插件版本
 * @param {object[]} o.builtins  内置模块定义（按启动顺序）
 */
// ── 出站治理（主动发言策略的模块侧接线，见 docs/OUTBOUND-POLICY-DESIGN.md / CONTRACT §5）──
// 第一道判定放在**模块包装层**：模块的每次发送都带上宿主绑定的 moduleId 去问策略，
// 放行才真的调 hub；hub 侧的 setOutboundGuard 是第二道保险（覆盖任何绕过包装层的直调）。
// 未注入服务（core.outbound 缺失：旧环境 / 纯测试）时全部返回放行 —— 完全惰性、零开销。

const NOOP_LOG = { warn() {} }

/** 取宿主注入的出站服务；没有或者面不对就当没注入。 */
function outboundOf(core) {
  const svc = core && core.outbound
  return svc && typeof svc.admit === 'function' ? svc : null
}

/** 模块包装层用的日志口（core.logger 由宿主注入；没有就静默）。 */
function outboundLogOf(core) {
  try {
    const l = core && core.logger
    return l && typeof l.child === 'function' ? l.child('出站策略') : NOOP_LOG
  } catch (error) {
    return NOOP_LOG
  }
}

/**
 * 模块发送的第一道判定。返回 { allow, verdict }。
 * 判定口径与 hub 门闸完全一致（同一个 svc.admit），只是身份由宿主绑定、模块伪造不了。
 * 治理故障按放行处理：策略源的问题不该把模块的正常发送全卡死（与 hub 门闸同一口径）。
 */
function admitModuleCall(core, id, ask, log) {
  const svc = outboundOf(core)
  if (!svc) return { allow: true, verdict: null }
  try {
    const verdict = svc.admit({
      to: ask.chatId,
      moduleId: id,
      origin: 'module',
      cause: ask.cause || null,
      itemId: ask.itemId || null,
      at: Date.now(),
      // 模块快捷发送没有排队执行器：broker 档也不排进账本，直接按判定结果走
      allowDefer: false,
    })
    const action = verdict && verdict.action
    // defer 只会在 broker 档出现，没有排队执行器时按 deny 处理（宁可不发，也不越过预算）
    const allow = action === 'allow'
    if (!allow) (log || NOOP_LOG).warn?.(`模块「${id}」这次主动发送被策略拦下（${(verdict && verdict.reason) || action || 'deny'}）`)
    return { allow, verdict: verdict || null }
  } catch (error) {
    (log || NOOP_LOG).warn?.(`出站判定出错，模块「${id}」这条按放行处理：`, error && error.message)
    return { allow: true, verdict: null }
  }
}

/** 结算一次模块发送的预占：发出去记 sent，没发出去 / 抛错记 failed（退款口径交给策略源自定）。 */
function settleModuleCall(core, verdict, outcome, log) {
  const svc = outboundOf(core)
  if (!svc || typeof svc.commit !== 'function' || !verdict || !verdict.reserveId) return
  try {
    svc.commit(verdict.reserveId, { deliveryId: verdict.deliveryId, outcome })
  } catch (error) {
    (log || NOOP_LOG).warn?.(`出站结算失败（${outcome}）：`, error && error.message)
  }
}

/**
 * 带治理地执行一次模块发送：
 *   放行 → 调 run(opts)；按结果结算（真值 → sent，假值 → failed）；
 *   拦下 → 直接返回 null（铁律：旧调用口的真值语义不变，CONTRACT §4）。
 * opts 里的 outboundDone 告诉 hub「这条已经判过了，别再判一次」，避免同一条消息扣两份额度。
 *
 * 未注入服务（旧环境 / 纯测试）时**不设** outboundDone：让 hub 的第二道保险（若宿主挂了）
 * 仍然生效；两道都没有时就是原样直发，与改造前逐字节等价。
 */
 /**
 * 带治理地执行一次模块发送：
 *   放行 → 调 run(opts)；按结果结算（真值 → sent，假值 → failed）；
 *   拦下 → 直接返回 null（铁律：旧调用口的真值语义不变，CONTRACT §4）。
 * opts 里的 outboundDone 告诉 hub「这条已经判过了，别再判一次」，避免同一条消息扣两份额度。
 *
 * broker 档 + 发往主人私聊的纯文本 → **改走宿主代发**（api.proactive.submit 的
 * hostDelegate 路径）：内容先进「目的引擎（代发决断）」会话过目，再由宿主统一投递。
 * 这样普通模块（douyin / tophub / bili……）不改一行代码，也会被引擎审查并留下会话记录；
 * 只有 broker 档这样走，gate 档与 pass 档行为不变。
 *
 * 未注入服务（旧环境 / 纯测试）时**不设** outboundDone：让 hub 的第二道保险（若宿主挂了）
 * 仍然生效；两道都没有时就是原样直发，与改造前逐字节等价。
 */
function governedSend(core, id, ask, run, log) {
  const svc = outboundOf(core)
  if (!svc) return run({ sourceModule: id })
  const gate = admitModuleCall(core, id, ask, log)
  if (!gate.allow) return null
  // broker 档的纯文本私聊主人：交给宿主代发（引擎决断 + 宿主投递 + 会话记录）
  const verdict = gate.verdict
  const delegate = brokerDelegable(core, verdict, ask)
  if (delegate) {
    // 代发是异步的（引擎决断要走一轮模型），返回 Promise：
    // 发出去了 → { message_id }，引擎决断不发 / 投递失败 → null（旧调用口语义不变）
    return delegateToHost(core, id, ask, verdict, delegate, log)
  }
  const done = (value) => {
    settleModuleCall(core, gate.verdict, value ? 'sent' : 'failed', log)
    return value
  }
  let r
  try {
    r = run({ sourceModule: id, outboundDone: true })
  } catch (error) {
    settleModuleCall(core, gate.verdict, 'failed', log)
    throw error
  }
  if (r && typeof r.then === 'function') {
    return r.then(done, (error) => {
      settleModuleCall(core, gate.verdict, 'failed', log)
      throw error
    })
  }
  return done(r)
}

/**
 * 这条模块发送该不该改交宿主代发？
 * 条件：broker 档 + admit 放行 + 发往主人私聊 + 有纯文本 + 宿主服务开了 submit。
 * 图片/文件/语音/群消息一律不走（代发决断只针对「一句话」，其余附件的语义不同）。
 */
function brokerDelegable(core, verdict, ask) {
  const svc = outboundOf(core)
  if (!svc || typeof svc.submit !== 'function') return null
  if (!verdict || verdict.action !== 'allow' || verdict.tier !== 'broker') return null
  const text = ask && ask.text !== undefined ? String(ask.text) : ''
  if (!text.trim()) return null
  const to = String((ask && ask.chatId) || '')
  // 只代发「主动私聊主人」；群聊、朋友私聊均按原路径。
  // 治理范围由服务自己判（它的 getConfig 里有 ownerQQ），模块层不必依赖 core.getConfig。
  const governed = typeof svc.isGoverned === 'function' ? svc.isGoverned(to) : false
  if (!governed) return null
  return svc
}

/**
 * 改交宿主代发：条目进账本、由宿主投递器（host.js 的 send）完成
 * 「审查预占 → 目的引擎（代发决断）会话 → hub.deliver 投递 → 结算」全过程。
 * 返回值语义与旧调用口保持一致：真发出去 → 真值（模块据此 `if (sent)` 判断）；
 * 引擎决断不发 / 投递失败 → null（旧调用方认得的失败值）。
 * 旧预占由宿主投递器内部的 reserveReview 接管，这里先把它释放掉，避免额度被重复占用。
 */
async function delegateToHost(core, id, ask, verdict, svc, log) {
  // 门闸已经放行并预占了额度，但代发路径不用这份预占（宿主内部走 review 预占）——
  // 立刻释放，保证「代发不占引擎说话额度」。
  if (verdict && verdict.reserveId && typeof svc.release === 'function') {
    try { svc.release(verdict.reserveId, { reason: 'delegated-to-host' }) } catch {}
  }
  try {
    const r = await svc.submit(
      { moduleId: id, itemId: ask.itemId || '', to: String(ask.chatId), channel: 'qq', text: String(ask.text ?? ''), at: Date.now() },
      { hostDelegate: true },
    )
    const state = r && typeof r === 'object' ? String(r.state || '') : ''
    if (state === 'sent' || state === 'pending' || state === 'queued') {
      return { message_id: 'delegated-' + r.deliveryId }
    }
    (log || NOOP_LOG).warn?.(`模块「${id}」这条代发没发出去（${state || 'unknown'}）`)
    (log || NOOP_LOG).warn?.(`模块「${id}」这条代发没发出去（${state || 'unknown'}）`)
    return null
  } catch (error) {
    (log || NOOP_LOG).warn?.(`模块「${id}」代发出错：`, error && error.message)
    return null
  }
}

/**
 * scopedHub 上这 6 个函数要过治理（CONTRACT §5）。
 * 其余名字照旧直接转发：hub 的内部入口（stats / sessions / chatOfSession……）与发送无关。
 */
const GOVERNED_HUB_METHODS = new Set(['sendText', 'sendSegments', 'sendImage', 'sendFile', 'sendVoiceFile', 'deliver'])

/**
 * 按方法名把一次 scopedHub 调用翻译成「治理问题 + 真正执行」。
 * 返回 null 表示这个方法不走治理（按原样转发）。
 *
 * 说明：每个分支的 ask 只取发送目标与文本，**身份一律由宿主绑定的 id 决定**，
 * 模块即使在自己参数里塞 moduleId / sourceModule 也覆盖不了（防止冒充别的模块）。
 */
function governScopedCall(core, id, name, args, log) {
  const [chatId, a, b, c] = args
  switch (name) {
    case 'sendText':
      // sendText(chatId, text, replyId, missed, userId, opts)
      return governedSend(core, id, { chatId, text: a }, (extra) => {
        const last = args[5]
        const opts = last && typeof last === 'object' ? { ...last, ...extra } : extra
        return core.hub.sendText(chatId, a, args[2], args[3], args[4], opts)
      }, log)
    case 'sendSegments':
      // sendSegments(chatId, segments, note, opts)
      return governedSend(core, id, { chatId, text: '' }, (extra) => {
        const last = args[3]
        const opts = last && typeof last === 'object' ? { ...last, ...extra } : extra
        return core.hub.sendSegments(chatId, a, b, opts)
      }, log)
    case 'sendImage':
      // sendImage(chatId, src, replyId, userId, opts)
      return governedSend(core, id, { chatId }, (extra) => {
        const last = args[4]
        const opts = last && typeof last === 'object' ? { ...last, ...extra } : extra
        return core.hub.sendImage(chatId, a, args[2], args[3], opts)
      }, log)
    case 'sendFile':
      // sendFile(chatId, file, name)
      return governedSend(core, id, { chatId }, () => core.hub.sendFile(chatId, a, b), log)
    case 'sendVoiceFile':
      // sendVoiceFile(chatId, file, note)
      return governedSend(core, id, { chatId }, () => core.hub.sendVoiceFile(chatId, a, b), log)
    case 'deliver': {
      // deliver(chatId, text, opts)：引擎路径（opts.enginePolicy）由 hub 自己 reserve，跳过主动门闸
      const opts = c && typeof c === 'object' ? c : {}
      if (opts.enginePolicy) return core.hub.deliver(chatId, a, opts)
      return governedSend(core, id, { chatId, text: a }, (extra) => core.hub.deliver(chatId, a, { ...opts, ...extra }), log)
    }
    default:
      return null
  }
}

/**
 * 给单个模块的 core：hub 下发「白名单副本」，原始委派入口不下发、也不可经原型链摸回（三审 #177）。
 * - scopedHub：平面对象，只转发 hub 的函数/取值器（跳过原始 runSubagentTurn / subagentFor），
 *   再补一个固定模块 id 的 runSubagentTurn；原型就是 Object.prototype，没有可逃逸的入口。
 * - 6 个发送函数额外过一层出站治理（moduleId 由宿主绑定，模块伪造不了；未注入服务时完全惰性）。
 * - scopedCore：Proxy 转发 core 的其余属性（bridge / modules 后挂的也可见），
 *   但 getPrototypeOf 掐成 null —— Object.getPrototypeOf(api.core).hub 也绕不回去。
 */
export function scopeCoreForModule(core, id) {
  if (!core || !core.hub || typeof core.hub.subagentFor !== 'function') return core || {}
  const obLog = outboundLogOf(core)
  const scopedHub = {}
  for (const name of Object.getOwnPropertyNames(core.hub)) {
    if (name === 'runSubagentTurn' || name === 'subagentFor') continue
    const d = Object.getOwnPropertyDescriptor(core.hub, name)
    if (!d) continue
    if (typeof d.get === 'function') {
      Object.defineProperty(scopedHub, name, { enumerable: true, configurable: true, get: () => core.hub[name] })
    } else if (typeof d.value === 'function') {
      const fn = d.value
      // 发送类入口走治理：拦下返回 null，放行才真的调 hub（旧真值语义不变）
      if (GOVERNED_HUB_METHODS.has(name)) {
        Object.defineProperty(scopedHub, name, {
          enumerable: true, configurable: true,
          value: (...args) => governScopedCall(core, id, name, args, obLog),
        })
      } else {
        Object.defineProperty(scopedHub, name, { enumerable: true, configurable: true, value: (...args) => fn.apply(core.hub, args) })
      }
    } else {
      Object.defineProperty(scopedHub, name, { enumerable: true, configurable: true, get: () => core.hub[name], set: (v) => { core.hub[name] = v } })
    }
  }
  Object.defineProperty(scopedHub, 'runSubagentTurn', {
    enumerable: true, configurable: true,
    value: (name, title, prompt, opts = {}) => core.hub.subagentFor(id)(name, title, prompt, opts),
  })
  return new Proxy(core, {
    get(target, key, recv) {
      if (key === 'hub') return scopedHub
      // 出站治理服务不下发给模块：模块能拿到原始 svc 就能自己填 moduleId 冒充别人，
      // 也会绕过 api.proactive 的身份绑定。模块只能走 api.proactive（见 makeApi）。
      if (key === 'outbound') return undefined
      return Reflect.get(target, key, recv)
    },
    getPrototypeOf() { return null }, // 摸原型拿回原始 hub 的路也堵死（三审 #177）
  })
}

export function createModules({ ctx, core, getConfig, setConfig, logger, version, builtins }) {
  const log = logger.child('modules')
  const builtinDefs = new Map(builtins.map((d) => [d.id, d]))
  const live = new Map() // id → 运行中的模块（见 start）
  const errors = new Map() // id → { message, at }  启动失败 / 加载失败
  const routes = new Map() // 完整路径 → { id, handler }
  const listeners = new Map() // 事件名 → [{ id, fn }]
  const revisions = new Map() // id → 停止次数，取消在途 import
  // 模块每次（重）启动都递增一次「代际」：hub 用它判断会话里挂的工具是不是旧模块实例的闭包。
  let generation = 0
  let userSeen = new Map() // id → { dir, file, stamp }
  let watching = null
  let disposed = false

  const modCfg = (id) => getConfig().modules?.[id] || {}
  const isEnabled = (id) => modCfg(id).enabled !== false
  const isUserOn = () => !getConfig().safeMode
  // 接口挂在哪：内置模块（以及从内置搬到社区库的那几个）沿用原来的根路径，别的模块挂在自己的 /ext/<id>/ 下。
  // 面板里的 call('/x') 要用同一份判断决定基址（见 status().routesAtRoot），两边不能各算各的。
  const routesAtRoot = (id) => builtinDefs.has(id) || STABLE_ROUTES.has(id)

  // ---------- 给模块的 api ----------
  function makeApi(id, source, rec) {
    const mlog = logger.child(id)
    const active = () => !disposed && !rec.stopped && live.get(id) === rec
    const writable = (label, fn) => (...args) => {
      if (!active()) {
        const error = new Error(`模块「${id}」已停止，不能调用 ${label}`)
        mlog.warn(error.message)
        throw error
      }
      return fn(...args)
    }
    const guard = (label, fn) => (...args) => {
      if (!active()) return
      try {
        const r = fn(...args)
        if (r && typeof r.then === 'function') return r.catch((error) => { note(id, label, error); throw error })
        return r
      } catch (error) {
        note(id, label, error)
        throw error
      }
    }
    const track = (off) => {
      if (typeof off === 'function') {
        if (active()) rec.offs.push(off)
        else cleanup(off)
      }
      return off
    }
    // 内置模块和替换它的版本用原来的路径（内置的面板页照常能用）；新模块放在 /ext/模块id/ 下
    const prefix = routesAtRoot(id) ? '' : `/ext/${id}`
    const def = rec.def
    // 模块拿到的 core：hub 换成「宿主按模块身份封装」的白名单副本（三审 #177：原型链斩断，
    // 模块摸不到原始 runSubagentTurn / subagentFor）；core 本体用 Proxy 转发，
    // getPrototypeOf 也掐断，防 getPrototypeOf(api.core).hub 绕回原始入口。
    const scopedCore = scopeCoreForModule(core, id)
    // 出站治理的日志口（模块快捷发送层的判定/结算都往这里记；未注入服务时不会用到）
    const obLog = outboundLogOf(core)
    const api = {
      id,
      source,
      // 模块自己的文件夹（读自己带的数据文件用这个；import.meta.url 指向的是加载快照）
      dir: rec.dir || join(BUILTIN_DIR, id),
      apiVersion: API_VERSION,
      version,
      log: mlog,
      // ---- 配置 ----
      config: () => getConfig(),
      setConfig: writable('setConfig', (patch) => setConfig(typeof patch === 'function' ? patch(getConfig()) : deepMerge(getConfig(), patch))),
      settings: () => ({ ...(def.defaults || {}), ...(getConfig().ext?.[id] || {}) }),
      saveSettings: writable('saveSettings', (patch) => {
        const cfg = getConfig()
        setConfig({ ...cfg, ext: { ...cfg.ext, [id]: { ...(cfg.ext?.[id] || {}), ...patch } } })
        return api.settings()
      }),
      dataDir: (...parts) => { const d = dataDir('modules-data', id); mkdirSync(d, { recursive: true }); return join(d, ...parts) },
      // ---- 别的模块和插件内部 ----
      use: (other) => exportsOf(other),
      lazy: (other) => lazyProxy(() => exportsOf(other)),
      has: (other) => live.has(other),
      core: scopedCore,
      dsh: ctx,
      lib,
      // ---- 往插件里加东西 ----
      tool: (builder) => { rec.tools.push(builder); return () => remove(rec.tools, builder) },
      defineTool,
      context: (fn) => { rec.contexts.push(fn); return () => remove(rec.contexts, fn) },
      rule: (fn) => { rec.rules.push(fn); return () => remove(rec.rules, fn) },
      command: (c) => {
        if (!c || !c.name || typeof c.run !== 'function') throw new Error('command 要有 name 和 run')
        const item = { ...c, module: id }
        rec.commands.push(item)
        return () => remove(rec.commands, item)
      },
      on: (event, fn) => {
        const item = { id, fn: guard(`事件 ${event}`, fn) }
        const list = listeners.get(event) || []
        list.push(item)
        listeners.set(event, list)
        const off = () => listeners.set(event, (listeners.get(event) || []).filter((x) => x !== item))
        track(off)
        return off
      },
      emit: writable('emit', (event, ...args) => emit(event, ...args)),
      every: (ms, fn, label = '定时任务') => {
        const t = setInterval(() => {
          if (!active()) return
          Promise.resolve().then(() => { if (active()) return fn() }).catch((error) => note(id, label, error))
        }, Math.max(1000, Number(ms) || 60_000))
        t.unref?.()
        return track(() => clearInterval(t))
      },
      later: (ms, fn) => {
        const t = setTimeout(() => { Promise.resolve().then(() => { if (active()) return fn() }).catch((error) => note(id, '延时任务', error)) }, Math.max(0, Number(ms) || 0))
        t.unref?.()
        return track(() => clearTimeout(t))
      },
      route: (path, handler) => {
        if (!active()) return () => {}
        const full = '/aurabot/api' + prefix + (String(path).startsWith('/') ? path : '/' + path)
        const cur = routes.get(full)
        if (cur && cur.id !== id && live.has(cur.id)) throw new Error(`接口 ${full} 已经被模块「${cur.id}」占了`)
        const route = { id, handler: guard(`接口 ${path}`, handler) }
        routes.set(full, route)
        return track(() => { if (routes.get(full) === route) routes.delete(full) })
      },
      onDispose: (fn) => track(fn),
      // ---- 常用操作的捷径（都是 core 里的东西包了一层）----
      // 发送类捷径先过一层出站治理（CONTRACT §5）：moduleId 由宿主绑定，模块伪造不了；
      // 拦下返回 null（旧真值语义不变），放行才真的调 hub 并由这里结算预占。
      // 未注入 core.outbound（旧环境 / 纯测试）时 admitModuleCall 直接放行，行为与改造前一致。
      // 注意 reply 不参与：那是「回某一条消息」的回合内响应，由 hub 自己的回复链路负责，
      // 不是模块自发的主对话（治理对象只有主动私聊主人）。
      send: writable('send', (chatId, text) => governedSend(core, id, { chatId: String(chatId), text: String(text ?? '') }, (extra) => core.hub.deliver(String(chatId), String(text ?? ''), extra), obLog)),
      sendText: writable('sendText', (chatId, text) => governedSend(core, id, { chatId: String(chatId), text: String(text ?? '') }, (extra) => core.hub.sendText(String(chatId), String(text ?? ''), undefined, undefined, undefined, extra), obLog)),
      // 回某一条消息：群里以「引用回复」发出，私聊直接发
      reply: writable('reply', (msg, text) => core.hub.sendText(String(msg.chatId), String(text ?? ''), msg.kind === 'group' ? msg.messageId : undefined)),
      isOwner: (userId) => String(userId) === String(getConfig().ownerQQ),
      sendImage: writable('sendImage', (chatId, src) => governedSend(core, id, { chatId: String(chatId) }, (extra) => core.hub.sendImage(String(chatId), src, undefined, undefined, extra), obLog)),
      sendSegments: writable('sendSegments', (chatId, segs, note) => governedSend(core, id, { chatId: String(chatId) }, (extra) => core.hub.sendSegments(String(chatId), segs, note || `[${id}]`, extra), obLog)),
      // 发任意文件（文档 / 压缩包 / 音频 / 视频……）：本机绝对路径，或网关能取到的网址 / base64://
      sendFile: writable('sendFile', (chatId, file, name) => governedSend(core, id, { chatId: String(chatId) }, () => core.hub.sendFile(String(chatId), file, name), obLog)),
      // 把一个音频文件当语音条发出去（不走念文字）
      sendVoiceFile: writable('sendVoiceFile', (chatId, file, note) => governedSend(core, id, { chatId: String(chatId) }, () => core.hub.sendVoiceFile(String(chatId), file, note || `[${id}] 语音`), obLog)),
      // module: id —— 这次模型调用的用量记到哪个模块名下（面板「概览」的 token 明细）
      ask: writable('ask', (opts) => core.ask(typeof opts === 'string' ? { text: opts, module: id } : { ...opts, module: id })),
      think: writable('think', (prompt, opts = {}) => core.hub.runSystemTurn(`ext-${id}`, opts.title || def.name || id, String(prompt), opts)),
      onebot: writable('onebot', (action, params, opts) => core.onebot.call(action, params, opts)),
      // 出站治理面（主动发言策略，见 docs/OUTBOUND-POLICY-DESIGN.md）。
      // 宿主注入 core.outbound 才有；旧环境/纯测试下 available=false，模块据此降级，
      // 绝不因此抛错。moduleId 由宿主闭包绑定，模块无法伪造他人身份。
      proactive: {
        // 用取值器而不是一次性求值：宿主可能晚于模块加载才注入 core.outbound，
        // 写成普通属性会导致 available 永远为 false（而 submit 实际可用）。
        get available() { return Boolean(core.outbound && typeof core.outbound.submit === 'function') },
        submit: writable('proactive.submit', (input = {}) => {
          const svc = core.outbound
          if (!svc || typeof svc.submit !== 'function') return { deliveryId: null, state: 'unsupported' }
          return svc.submit({ ...(input || {}), moduleId: id })
        }),
        statusOf: writable('proactive.statusOf', (deliveryId) => {
          const svc = core.outbound
          if (!svc || typeof svc.statusOf !== 'function') return null
          return svc.statusOf(deliveryId)
        }),
      },
      dshTool: (tool) => { if (!active()) return () => {}; rec.dshTools.push(tool); core.bridge?.refresh(); return () => { remove(rec.dshTools, tool); core.bridge?.refresh() } },
    }
    return api
  }

  function remove(list, item) {
    const i = list.indexOf(item)
    if (i >= 0) list.splice(i, 1)
  }

  function note(id, label, error) {
    const message = String(error && error.message ? error.message : error).slice(0, 500)
    const rec = live.get(id)
    if (rec) {
      rec.errors.unshift({ at: Date.now(), label, message })
      rec.errors.length = Math.min(rec.errors.length, 8)
    }
    log.warn(`模块「${id}」${label}出错：`, message)
  }

  function exportsOf(id) {
    const rec = live.get(id)
    return rec ? rec.exports : null
  }

  // 卸载接口保持同步；模块自己的同步 / 异步收尾失败只记日志。
  function cleanup(fn) {
    const failed = (error) => log.warn('模块清理失败：', String(error?.message || error))
    try { Promise.resolve(fn()).catch(failed) } catch (error) { failed(error) }
  }

  // ---------- 启动 / 停止 ----------
  async function start(def, source, extra = {}) {
    if (disposed) return null
    const id = def.id
    const rec = { id, def, source, exports: null, offs: [], tools: [], contexts: [], rules: [], commands: [], dshTools: [], errors: [], startedAt: Date.now(), ...extra }
    // 设置里的密码字段不回传给面板
    for (const f of def.settings || []) if (f && f.type === 'password' && f.key) registerSecretField(['ext', id, f.key])
    // 设置的默认值补进配置（面板表单直接有值可改；已经填过的不动）
    if (def.defaults && typeof def.defaults === 'object') {
      const cur = getConfig().ext?.[id] || {}
      const missing = Object.keys(def.defaults).filter((k) => !(k in cur))
      if (missing.length) setConfig({ ...getConfig(), ext: { ...getConfig().ext, [id]: { ...Object.fromEntries(missing.map((k) => [k, def.defaults[k]])), ...cur } } })
    }
    live.set(id, rec)
    errors.delete(id)
    generation++ // 新实例：会话里的工具要在下一轮重挂（issue #73）
    try {
      const api = makeApi(id, source, rec)
      const r = def.setup(api)
      const exports = (r && typeof r.then === 'function' ? await r : r) ?? {}
      if (disposed || rec.stopped || live.get(id) !== rec) {
        cleanup(() => exports?.dispose?.())
        return null
      }
      rec.exports = exports
      log.info(`模块「${def.name || id}」${source !== 'user' ? '' : existsSync(join(rec.dir, '.aurabot-source.json')) ? '（模块市场）' : '（自己写的）'}已启动`)
      emit('module/start', id)
    } catch (error) {
      if (disposed || rec.stopped || live.get(id) !== rec) return null
      stop(id, { quiet: true })
      errors.set(id, { message: String(error && error.message ? error.message : error).slice(0, 800), at: Date.now(), source })
      log.warn(`模块「${def.name || id}」启动失败：`, error.message)
    }
    return live.get(id)
  }

  /** 同步启动（内置模块的 setup 都是同步的，插件一加载就要能用）。 */
  function startSync(def) {
    if (disposed) return
    const id = def.id
    const rec = { id, def, source: 'builtin', exports: null, offs: [], tools: [], contexts: [], rules: [], commands: [], dshTools: [], errors: [], startedAt: Date.now() }
    live.set(id, rec)
    generation++ // 内置模块（重）启动也换代际：会话里的工具要在下一轮重挂
    if (errors.get(id)?.source !== 'user') errors.delete(id) // 替换版的报错留着给面板看
    try {
      const r = def.setup(makeApi(id, 'builtin', rec))
      if (r && typeof r.then === 'function') throw new Error('内置模块的 setup 要同步返回')
      rec.exports = r ?? {}
    } catch (error) {
      stop(id, { quiet: true })
      errors.set(id, { message: String(error.message || error).slice(0, 800), at: Date.now(), source: 'builtin' })
      log.error(`内置模块「${def.name || id}」启动失败：`, error.message)
    }
  }

  function stop(id, { quiet = false } = {}) {
    revisions.set(id, (revisions.get(id) || 0) + 1)
    const rec = live.get(id)
    if (!rec) return false
    live.delete(id)
    generation++ // 停止或替换也使会话工具缓存失效
    rec.stopped = true
    for (const off of rec.offs.splice(0).reverse()) cleanup(off)
    cleanup(() => rec.exports?.dispose?.())
    rec.exports = null
    // 路由和监听器由各自的 off 按实例撤销，清理期间可能已经启动了同名新实例。
    if (rec.dshTools.length) core.bridge?.refresh()
    if (!quiet) { log.info(`模块「${rec.def.name || id}」已停下`); emit('module/stop', id) }
    return true
  }

  /** 加载一个自己写的模块（按修改时间重新 import，改了就是新的）。 */
  /**
   * 加载自己写的模块：先把整个文件夹拍一份快照（modules/<id>/.aurabot-cache/<版本戳>/）再加载快照。
   * Node 会缓存加载过的文件，快照路径每次不同，所以改了模块里任何一个文件都会重新加载；
   * 快照在模块文件夹里面，模块自己 npm install 的依赖（modules/<id>/node_modules）照样找得到。
   */
  async function importUser(u) {
    const stamp = stampOf(u.dir)
    const root = join(u.dir, SNAP)
    const snap = join(root, String(stamp).replace('.', '-'))
    if (!existsSync(snap)) {
      for (const f of filesOf(u.dir)) {
        mkdirSync(dirname(join(snap, f)), { recursive: true })
        copyFileSync(join(u.dir, f), join(snap, f))
      }
    }
    // 旧快照删掉（加载过的代码已经在内存里，删文件不影响）
    try { for (const n of readdirSync(root)) if (join(root, n) !== snap) rmSync(join(root, n), { recursive: true, force: true }) } catch (error) {}
    const mod = await import(pathToFileURL(join(snap, relative(u.dir, u.file))).href)
    return { def: mod.default, stamp }
  }

  async function startUser(u) {
    if (disposed) return null
    const revision = revisions.get(u.id) || 0
    const stillWanted = () => {
      const users = isUserOn() ? scanUser() : []
      return wanted(u.id, users) === 'user' && users.some((item) => item.id === u.id && item.file === u.file)
    }
    let def
    let stamp = 0
    try {
      ({ def, stamp } = await importUser(u))
      if (disposed || (revisions.get(u.id) || 0) !== revision) return null
      if (!stillWanted()) { resyncRequested = true; return null }
      const why = checkDef(def, u.id)
      if (why) throw new Error(why)
    } catch (error) {
      if (disposed || (revisions.get(u.id) || 0) !== revision) return null
      if (!stillWanted()) { resyncRequested = true; return null }
      errors.set(u.id, { message: String(error.message || error).slice(0, 800), at: Date.now(), source: 'user', fallback: builtinDefs.has(u.id) })
      log.warn(`模块「${u.id}」加载失败：`, error.message)
      userSeen.set(u.id, { ...u, stamp: stampOf(u.dir) })
      return null
    }
    userSeen.set(u.id, { ...u, stamp })
    // 替换内置模块：记下替换时内置模块的版本，以后内置的更新了提醒一声
    const b = builtinDefs.get(u.id)
    const extra = { dir: u.dir }
    if (b) {
      extra.replaces = b.version
      const m = modCfg(u.id)
      if (!m.forkedFrom) setConfig({ ...getConfig(), modules: { ...getConfig().modules, [u.id]: { ...m, forkedFrom: b.version || version } } })
    }
    // setConfig 可能同步触发安全模式或关闭模块，再确认一次才执行 setup。
    if (disposed || (revisions.get(u.id) || 0) !== revision) return null
    if (!stillWanted()) { resyncRequested = true; return null }
    return start(def, 'user', extra)
  }

  /** 这个 id 现在该跑哪个版本：'user' | 'builtin' | null（关着）。 */
  function wanted(id, users) {
    if (!isEnabled(id)) return null
    const hasUser = isUserOn() && users.some((u) => u.id === id)
    if (hasUser && !(builtinDefs.has(id) && modCfg(id).useBuiltin)) return 'user'
    return builtinDefs.has(id) ? 'builtin' : null
  }

  /** 插件加载时：内置模块同步启动（被替换 / 关掉的跳过），自己写的随后异步加载。 */
  function boot() {
    if (disposed) return Promise.resolve()
    const users = isUserOn() ? scanUser() : []
    for (const def of builtins) if (wanted(def.id, users) === 'builtin') startSync(def)
    return (async () => {
      await loadLib()
      if (disposed) return
      globalThis.aurabot = { lib, src: pathToFileURL(SRC).href, version, apiVersion: API_VERSION, modules: publicHandle }
      installDocs()
      await sync()
      if (disposed) return
      watching = setInterval(() => { sync().catch((error) => log.warn('检查模块变化出错：', error.message)) }, 3000)
      watching.unref?.()
    })().catch((error) => log.error('加载自己写的模块出错：', error.message))
  }

  /** 按配置和文件夹的现状，把该开的开、该关的关、改过的重新加载。 */
  let syncing = null
  let resyncRequested = false
  async function syncPass() {
    const users = isUserOn() ? scanUser() : []
    const ids = new Set([...builtinDefs.keys(), ...users.map((u) => u.id), ...live.keys()])
    for (const id of ids) {
      if (disposed || resyncRequested) return
      const want = wanted(id, users)
      const rec = live.get(id)
      const u = users.find((x) => x.id === id)
      if (!want) { if (rec) stop(id); continue }
      if (want === 'builtin') {
        if (rec && rec.source === 'builtin') continue
        if (rec) stop(id)
        if (errors.get(id)?.source === 'builtin' && !rec) continue // 内置的启动失败过，别每 3 秒重试
        startSync(builtinDefs.get(id))
        continue
      }
      // 自己写的：没跑、换了文件、改过 → (重新)加载
      const seen = userSeen.get(id)
      const changed = !seen || seen.file !== u.file || seen.stamp !== stampOf(u.dir)
      if (rec && rec.source === 'user' && !changed) continue
      if (!changed && (!rec || rec.fallback)) continue // 上次加载失败、文件也没改：等改了再试
      if (rec) stop(id, { quiet: true })
      if (seen && changed) log.info(`模块「${id}」文件改了，重新加载`)
      const revision = revisions.get(id) || 0
      const ok = await startUser(u)
      if (disposed) return
      // import 期间被停止或改了配置时，由下一次检查决定是否启动。
      if ((revisions.get(id) || 0) !== revision || resyncRequested) continue
      // 替换版加载失败：先用回内置的，免得这项功能直接没了
      if (!ok && builtinDefs.has(id)) {
        startSync(builtinDefs.get(id))
        const back = live.get(id)
        if (back) { back.fallback = true; log.warn(`模块「${id}」：你的版本没加载成功，先用内置的`) }
      }
    }
    for (const id of [...userSeen.keys()]) if (!users.some((u) => u.id === id)) { userSeen.delete(id); if (errors.get(id)?.source === 'user') errors.delete(id) }
  }

  function sync() {
    if (disposed) return Promise.resolve()
    if (syncing) { resyncRequested = true; return syncing }
    syncing = (async () => {
      do {
        resyncRequested = false
        await syncPass()
      } while (resyncRequested && !disposed)
    })().finally(() => { syncing = null })
    return syncing
  }

  /** 强制重新加载一个模块（面板「重新加载」）。 */
  async function reload(id) {
    stop(id, { quiet: true })
    errors.delete(id)
    userSeen.delete(id)
    await sync()
    return status().find((m) => m.id === id) || null
  }

  function dispose() {
    if (disposed) return
    disposed = true
    clearInterval(watching)
    for (const id of [...live.keys()].reverse()) stop(id, { quiet: true })
    routes.clear()
    listeners.clear()
    if (globalThis.aurabot?.modules === publicHandle) delete globalThis.aurabot
  }

  // ---------- 事件 ----------
  function emit(event, ...args) {
    if (disposed) return
    for (const { fn } of listeners.get(event) || []) {
      try { const r = fn(...args); if (r && typeof r.catch === 'function') r.catch(() => {}) } catch (error) {}
    }
  }
  /** 依次问每个模块，第一个返回真值的接管（收到消息时用）。 */
  async function claim(event, ...args) {
    for (const { fn } of listeners.get(event) || []) {
      try { if (await fn(...args)) return true } catch (error) {}
    }
    return false
  }
  /** 依次让每个模块改写一个值（发回复前用）：返回 undefined 不改，null 拦下。 */
  async function filter(event, value, ...args) {
    let v = value
    for (const { fn } of listeners.get(event) || []) {
      try {
        const r = await fn(v, ...args)
        if (r === null) return null
        if (r !== undefined) v = r
      } catch (error) {}
    }
    return v
  }
  /** 同步版（人格、规则、模型选择这些地方不能等）：监听函数返回 Promise 的不算。 */
  function filterSync(event, value, ...args) {
    let v = value
    for (const { fn } of listeners.get(event) || []) {
      try {
        const r = fn(v, ...args)
        if (r && typeof r.then === 'function') continue
        if (r === null) return null
        if (r !== undefined) v = r
      } catch (error) {}
    }
    return v
  }

  // ---------- 汇总给插件其他部分用 ----------
  function buildTools(where) {
    const out = []
    const names = new Set()
    for (const rec of live.values()) {
      for (const b of rec.tools) {
        let r
        try { r = typeof b === 'function' ? b(where) : b } catch (error) { note(rec.id, '生成工具', error); continue }
        for (const t of [].concat(r || [])) {
          if (!t || !t.name) continue
          if (names.has(t.name)) { log.debug(`工具 ${t.name} 重名，模块「${rec.id}」的没挂`); continue }
          names.add(t.name)
          out.push(t)
        }
      }
    }
    return out
  }
  function contextFor(args) {
    const parts = []
    for (const rec of live.values()) {
      for (const fn of rec.contexts) {
        try { const t = fn(args); if (t) parts.push(String(t)) } catch (error) {}
      }
    }
    return parts.join('\n\n')
  }
  function rules(kind) {
    const out = []
    for (const rec of live.values()) {
      for (const fn of rec.rules) {
        try { const t = typeof fn === 'function' ? fn(kind, getConfig()) : fn; for (const line of [].concat(t || [])) if (line) out.push(String(line)) } catch (error) {}
      }
    }
    return out
  }
  const commands = () => [...live.values()].flatMap((r) => r.commands)
  const dshTools = () => [...live.values()].flatMap((r) => r.dshTools.map((t) => ({ ...t, module: r.id })))
  /** 内置模块里没在跑的（关掉的、被替换的）。 */
  const builtinOff = () => new Set([...builtinDefs.keys()].filter((id) => live.get(id)?.source !== 'builtin'))

  async function handle(path, req, res) {
    const r = routes.get(path)
    if (!r || !live.has(r.id)) return { ok: false, message: '这个功能所在的模块没开（面板「已安装」里看看）', moduleOff: true }
    return r.handler(req, res)
  }

  /**
   * 模块声明的能力（module.json 的 capabilities 数组）：内置模块没有 module.json 就当未声明（[]）。
   * 子智能体委派这类「要本机权限」的能力靠它把关（一审 #177）：没声明就不许用。
   */
  function capabilitiesOf(id) {
    const key = String(id || '')
    if (!ID_RE.test(key)) return []
    for (const dir of [join(userDir(), key), join(BUILTIN_DIR, key)]) {
      const file = join(dir, 'module.json')
      if (!existsSync(file)) continue
      try {
        const m = JSON.parse(readFileSync(file, 'utf8'))
        return Array.isArray(m.capabilities) ? m.capabilities.map(String) : []
      } catch (error) {
        return []
      }
    }
    return []
  }

  // ---------- 面板 ----------
  function status() {
    const users = isUserOn() ? scanUser() : scanUser().map((u) => ({ ...u, safe: true }))
    // 文件夹刚删掉、还没来得及停的模块也列出来（下一轮检查就停）
    const ids = [...builtinDefs.keys(), ...[...new Set([...users.map((u) => u.id), ...live.keys()])].filter((id) => !builtinDefs.has(id)).sort()]
    return ids.map((id) => {
      const b = builtinDefs.get(id)
      const u = users.find((x) => x.id === id)
      const rec = live.get(id)
      const def = rec?.def || b || {}
      const m = modCfg(id)
      const err = errors.get(id)
      return {
        id,
        name: def.name || id,
        description: def.description || '',
        version: def.version || '',
        builtin: Boolean(b),
        builtinVersion: b?.version || '',
        hasUser: Boolean(u),
        community: Boolean(u && existsSync(join(u.dir, '.aurabot-source.json'))),
        userDir: u?.dir || '',
        safeSkipped: Boolean(u?.safe),
        running: rec ? rec.source : null, // 'builtin' | 'user' | null
        fallback: Boolean(rec?.fallback),
        enabled: m.enabled !== false,
        useBuiltin: Boolean(m.useBuiltin),
        forkedFrom: m.forkedFrom || '',
        outdated: Boolean(b && rec?.source === 'user' && m.forkedFrom && m.forkedFrom !== b.version),
        error: err ? err.message : '',
        errors: rec ? rec.errors : [],
        tools: rec ? toolNames(rec) : [],
        commands: rec ? rec.commands.map((c) => c.name) : [],
        routes: [...routes].filter(([, r]) => r.id === id).map(([p]) => p.replace('/aurabot/api', '')),
        settings: rec?.source === 'user' || (!rec && u) ? (def.settings || []) : [],
        defaults: def.defaults || {},
        // 内置模块也能带面板：内置和用户模块走同一条加载链路，面板只按「定义里有没有声明 panel」判断。
        // 不再要求 rec.source === 'user'，否则内置模块写了 panel.js 也永远显示不出来。
        // 仍然要求模块在跑（rec 存在），没跑起来的模块没有面板代码可读。
        panel: Boolean(rec && def.panel),
        // 接口是不是挂在根路径（内置模块的老路径）；面板里的 call() 靠它决定加不加 /ext/<id> 前缀
        routesAtRoot: routesAtRoot(id),
        tab: def.tab || '',
        flag: typeof def.flag === 'string' ? def.flag : (def.settings || []).some((f) => f?.key === 'enabled') ? 'enabled' : '',
        keepPanel: Boolean(def.keepPanel),
        startedAt: rec?.startedAt || 0,
      }
    })
  }
  function toolNames(rec) {
    const names = []
    for (const b of rec.tools) {
      try {
        const r = typeof b === 'function' ? b({ chat: { chatId: 'private:0', kind: 'private', userId: '0' }, level: 'full', sessionId: '' }) : b
        for (const t of [].concat(r || [])) if (t?.name) names.push(t.name)
      } catch (error) {}
    }
    return names
  }

  /** file 是不是在 root 目录里面（root 自己不算；越过 root 的 ../ 一律不算）。 */
  function inside(root, file) {
    const rel = relative(resolve(root), resolve(file))
    return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
  }

  /**
   * 模块的面板代码（panel.js），面板拿去执行。
   * 内置模块也允许带面板：两者本来就是同一条加载链路，面板只需要「定义里声明了 panel」。
   * 面板文件从模块自己的文件夹读：用户模块在数据目录 modules/<id>，内置模块在 src/modules/<id>；
   * 两边都要求落在各自的根目录里，防止 panel 写成 ../../xxx 去读根目录外面的文件。
   */
  function panelSource(id) {
    const rec = live.get(id)
    if (!rec || !rec.def.panel) return null
    // 内置模块的根目录是 src/modules/<id>；id 先按 ID_RE 校验，别让奇怪的名字把根目录带到外面去。
    const builtin = rec.source !== 'user'
    const root = builtin
      ? (ID_RE.test(String(id)) ? join(BUILTIN_DIR, id) : '')
      : (rec.dir || userSeen.get(id)?.dir || '')
    if (!root) return null
    const file = resolve(root, typeof rec.def.panel === 'string' ? rec.def.panel : 'panel.js')
    if (!inside(root, file) || !existsSync(file)) return null
    return readFileSync(file, 'utf8')
  }

  /** 新建一个自己写的模块（从模板）。 */
  function create(id, name) {
    if (!ID_RE.test(id)) return { ok: false, message: 'id 要小写字母开头，只能有小写字母、数字和 -，比如 weather' }
    const dir = join(userDir(), id)
    if (existsSync(dir)) return { ok: false, message: `modules/${id} 已经有了` }
    mkdirSync(dir, { recursive: true })
    const tpl = readFileSync(join(BUILTIN_DIR, '_template', 'index.mjs'), 'utf8')
    writeFileSync(join(dir, 'index.mjs'), tpl.replaceAll('__TOOL__', id.replace(/-/g, '_')).replaceAll('__ID__', id).replaceAll('__NAME__', String(name || id).replace(/['\\\n]/g, '')), 'utf8')
    installDocs()
    return { ok: true, dir, file: join(dir, 'index.mjs'), message: `建好了：${join(dir, 'index.mjs')}` }
  }

  /** 把内置模块复制一份到 modules/ 里，改了就替换内置的。files 里列的实现文件一起复制。 */
  function fork(id) {
    const b = builtinDefs.get(id)
    if (!b) return { ok: false, message: '没有这个内置模块' }
    const dir = join(userDir(), id)
    if (existsSync(dir)) return { ok: false, message: `modules/${id} 已经有了，先挪走它` }
    const own = new Map() // 源码 key → 复制后的文件名
    own.set(`modules/${id}/index.js`, 'index.mjs')
    for (const f of b.files || []) own.set(f, f.split('/').pop())
    mkdirSync(dir, { recursive: true })
    for (const [key, name] of own) {
      // 指向插件其他文件的改成走 lib()；一起复制过来的文件之间互相引用的，改成同目录
      let code = rewriteImports(readFileSync(join(SRC, ...key.split('/')), 'utf8'), key, new Set(own.keys()))
      for (const [k2, n2] of own) {
        const relFrom = relative(dirname(join(SRC, ...key.split('/'))), join(SRC, ...k2.split('/'))).split(sep).join('/')
        const spec = relFrom.startsWith('.') ? relFrom : './' + relFrom
        code = code.split(`'${spec}'`).join(`'./${n2}'`)
      }
      writeFileSync(join(dir, name), `// 从 Aurabot v${version} 的内置模块「${b.name}」复制出来的，改了就替换内置的。\n// 原文件：src/${key}\n` + code, 'utf8')
    }
    setConfig({ ...getConfig(), modules: { ...getConfig().modules, [id]: { ...modCfg(id), useBuiltin: false, forkedFrom: b.version || version } } })
    installDocs()
    return { ok: true, dir, message: `复制好了：${dir}。改完保存，几秒内就会换成你的版本` }
  }

  /** 接口说明和类型提示放进 modules/（插件的东西，每次启动都覆盖成当前版本）。 */
  function installDocs() {
    try {
      mkdirSync(userDir(), { recursive: true })
      const doc = readFileSync(join(BUILTIN_DIR, DOC), 'utf8').replaceAll('{{VERSION}}', version).replaceAll('{{API}}', String(API_VERSION)).replace('{{LIB}}', libKeys().map((k) => '- `' + k + '`').join('\n'))
      const dest = join(userDir(), DOC)
      if (!existsSync(dest) || readFileSync(dest, 'utf8') !== doc) writeFileSync(dest, doc, 'utf8')
      // 类型提示：模块开头写 /** @type {import('../aurabot').AurabotModule} */，编辑器就有补全
      const types = readFileSync(join(BUILTIN_DIR, TYPES), 'utf8')
      const tdest = join(userDir(), TYPES)
      if (!existsSync(tdest) || readFileSync(tdest, 'utf8') !== types) writeFileSync(tdest, types, 'utf8')
    } catch (error) {}
  }

  function promptFor(id) {
    const dir = id ? join(userDir(), id) : userDir()
    return `帮我修改 Aurabot（${selfName(getConfig())} QQ 插件）的扩展模块：${dir}\n`
      + `先完整读一遍「${join(userDir(), DOC)}」了解模块怎么写、能用哪些接口，再按我的要求改：\n`
      + '【这里写你想让她多会什么、改成什么样】\n'
      + `只改 ${userDir()} 里的文件，不要动插件本身的代码；改完保存会自动重新加载，到面板「已安装」页看有没有报错，再告诉我怎么试。`
  }

  const publicHandle = { use: exportsOf, has: (id) => live.has(id), list: () => status().map(({ id, name, running }) => ({ id, name, running })), emit }

  return {
    boot, sync, reload, stop, dispose, status, create, fork, promptFor, panelSource,
    use: exportsOf, has: (id) => live.has(id), running: (id) => live.get(id)?.source || null, generation: () => generation,
    capabilitiesOf,
    emit, claim, filter, filterSync, buildTools,
    // 插件核心自己听事件（不属于任何模块，不会被撤掉）
    listen: (event, fn) => { const item = { id: '@core', fn }; listeners.set(event, [...(listeners.get(event) || []), item]); return () => listeners.set(event, (listeners.get(event) || []).filter((x) => x !== item)) }, contextFor, rules, commands, dshTools, builtinOff, handle,
    hasRoute: (path) => routes.has(path),
    dir: userDir,
  }
}

/**
 * 一个「用的时候才去找」的模块代理：memory.add(...) 每次都调当时在跑的那个 memory 模块；
 * 模块没在跑时，属性都是 undefined（所以调用方写 memory.add?.(...) 就不会出错）。
 */
export function lazyProxy(get) {
  return new Proxy({}, {
    get(_, k) {
      const t = get()
      if (!t) return undefined
      const v = t[k]
      return typeof v === 'function' ? v.bind(t) : v
    },
    has: (_, k) => Boolean(get() && k in get()),
  })
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
function deepMerge(base, over) {
  if (!isObj(over)) return over === undefined ? base : over
  const out = { ...(isObj(base) ? base : {}) }
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v
  return out
}
