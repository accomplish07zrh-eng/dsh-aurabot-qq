// 小黑盒 web 接口的签名与请求底座。
//
// 签名（hkey）来自前端 Tr 函数的等价实现：
//   · ALPHABET 字符集映射
//   · MD5 尾部 6 字节全部参与校验和（前 4 个位混合 + 后 2 个原样，6 个一起求和 %100）
//   · 写接口额外要 _rnd：HMAC-SHA256，盐值来自前端源码
//
// 限流 / 风控（参考 dph-heybox、xiaoheihe-cli、xiaoheihe-agent 的做法）：
//   · 按接口分档：搜索最凶（8s）、帖子详情次之（2.5s）、信息流（1.2s）、写接口（3s 起）
//   · 每档都加 ±20% 抖动，避免固定节拍被识别成脚本
//   · 一旦小黑盒回 show_captcha / need_captcha / 429，立刻停手，按指数退避冷却
//     （5 分钟 → 20 分钟 → 1 小时 → 3 小时 → 8 小时），冷却期内不发任何请求
//   · 写请求永不自动重试（重试只会让风控更严）
//
// 图片上传走腾讯云 COS 直传四步（info → token → PUT → callback），签名是标准 COS XML API。

import crypto from 'node:crypto'

export const API_BASE = 'https://api.xiaoheihe.cn'
export const WEB_BASE = 'https://www.xiaoheihe.cn'

const ALPHABET = 'AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89'
const HMAC_SALT = 'Z7mFG4tQp9Ws2LxB8H'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

// web 端通用参数（与真实请求一致）
export const BASE_PARAMS = {
  os_type: 'web',
  app: 'heybox',
  client_type: 'web',
  version: '999.0.4',
  web_version: '3.0',
  x_client_type: 'web',
  x_app: 'heybox_website',
  x_os_type: 'Windows',
  device_info: 'Chrome',
  device_id: '2c2fef8385ccef915e3b3caf94e3aa06',
}

// 真实存在的分区（网上抄来的 58144 之类并不存在，会一直报「错误的帖子类型」）
export const TOPICS = {
  7214: '盒友杂谈',
  18745: '数码硬件',
  806933: 'AI',
}

/** 按接口分档的最小间隔（毫秒）。顺序有意义：先匹配到的生效。 */
const TIERS = [
  { name: 'search', re: /^\/bbs\/(app\/)?api\/general\/search/, gap: 8000 },
  { name: 'detail', re: /^\/bbs\/app\/link\/tree/, gap: 2500 },
  { name: 'feed', re: /^\/bbs\/app\/feeds/, gap: 1200 },
  { name: 'hot', re: /^\/bbs\/app\/api\/search\/welcome_page/, gap: 1500 },
  { name: 'comment', re: /^\/bbs\/app\/comment\//, gap: 4000 },
  { name: 'upload', re: /^\/bbs\/app\/api\/qcloud\//, gap: 1500 },
]
const DEFAULT_GAP = 900
const WRITE_GAP = 3000

/** 冷却阶梯：命中验证码 / 429 后逐级抬高，成功一段时间后回落。 */
export const COOLDOWN_STEPS = [5 * 60_000, 20 * 60_000, 60 * 60_000, 3 * 3600_000, 8 * 3600_000]

/** 路径属于哪一档（给上层做提示用） */
export function tierOf(path) {
  const hit = TIERS.find((t) => t.re.test(String(path || '')))
  return hit ? hit.name : 'default'
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex')

// GF(2^8) 风格的双倍运算，与前端 w3 等价
const dbl = (v) => ((v << 1) ^ (v & 128 ? 27 : 0)) & 255
const thr = (v) => dbl(v) ^ v
const nin = (v) => thr(dbl(v))
const elv = (v) => nin(thr(dbl(v)))
const tht = (v) => elv(v) ^ nin(v) ^ thr(v)

const mix4 = (a, b, c, d) => [
  tht(a) ^ elv(b) ^ nin(c) ^ thr(d),
  thr(a) ^ tht(b) ^ elv(c) ^ nin(d),
  nin(a) ^ thr(b) ^ tht(c) ^ elv(d),
  elv(a) ^ nin(b) ^ thr(c) ^ tht(d),
]

const mapChars = (value, alphabet) => {
  let out = ''
  for (const ch of String(value)) out += alphabet[ch.charCodeAt(0) % alphabet.length]
  return out
}

/** 按路径 + 时间戳 + nonce 算 hkey（7 字符：5 位前缀 + 2 位校验和） */
export function hkey(path, timestamp, nonce) {
  const norm = '/' + String(path).split('/').filter(Boolean).join('/') + '/'
  const comps = [
    mapChars(timestamp, ALPHABET.slice(0, -2)),
    mapChars(norm, ALPHABET),
    mapChars(nonce, ALPHABET),
  ]
  const max = Math.max(...comps.map((c) => c.length))
  let interleaved = ''
  for (let k = 0; k < max; k += 1) {
    for (const c of comps) if (k < c.length) interleaved += c[k]
  }
  const digest = md5(interleaved.slice(0, 20))
  const tail = [...digest.slice(-6)].map((c) => c.charCodeAt(0))
  const mixed = [...mix4(tail[0], tail[1], tail[2], tail[3]), tail[4], tail[5]]
  const checksum = String(mixed.reduce((a, b) => a + b, 0) % 100).padStart(2, '0')
  return mapChars(digest.slice(0, 5), ALPHABET.slice(0, -4)) + checksum
}

/** 生成 nonce：32 位大写 hex */
export function makeNonce(timestamp = Math.floor(Date.now() / 1000)) {
  return md5(`${timestamp}${Date.now()}${Math.random()}`).toUpperCase()
}

/** 写接口附加签名 _rnd */
export function rndSignature(nonce, time) {
  const message = `${HMAC_SALT}${nonce}${time}:${nonce}`
  return '15:' + crypto.createHmac('sha256', HMAC_SALT).update(message).digest('hex')
}

/** 一次性生成 hkey / _time / nonce（可选 _rnd） */
export function signParams(path, { workshop = false, timestamp, nonce } = {}) {
  const t = timestamp ?? Math.floor(Date.now() / 1000)
  const n = nonce ?? makeNonce(t)
  const out = { hkey: hkey(path, t, n), _time: t, nonce: n }
  if (workshop) out._rnd = rndSignature(n, t)
  return out
}

/** 腾讯云 COS 直传签名（标准 COS XML API，临时密钥） */
export function cosSign({ secretId, secretKey, path, host, contentLength, keyTime }) {
  const hmac1 = (key, msg) => crypto.createHmac('sha1', key).update(msg).digest('hex')
  const signKey = hmac1(secretKey, keyTime)
  const httpString = `put\n${path}\n\ncontent-length=${contentLength}&host=${host}\n`
  const stringToSign = `sha1\n${keyTime}\n${sha1(httpString)}\n`
  const signature = hmac1(signKey, stringToSign)
  return 'q-sign-algorithm=sha1'
    + `&q-ak=${encodeURIComponent(secretId)}`
    + `&q-sign-time=${keyTime}&q-key-time=${keyTime}`
    + '&q-header-list=content-length;host&q-url-param-list='
    + `&q-signature=${signature}`
}

/** 统一的失败语义：登录态 / 验证码 / 限流 / 冷却都要能分辨，上层才能给出对的提示 */
export class HeyboxError extends Error {
  constructor(message, code = 'api', extra = {}) {
    super(message)
    this.name = 'HeyboxError'
    this.code = code
    this.extra = extra
  }
}

const AUTH_STATUS = new Set(['relogin', 'not_login', 'need_login', 'login_required', 'need_google_check'])
const CAPTCHA_STATUS = new Set(['show_captcha', 'need_captcha', 'need_verify', 'verify_required'])

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** 从接口返回里认出「要验证 / 被限流」——status 之外，msg 里也常写。 */
function riskOf(data, status) {
  if (!isObj(data)) return ''
  if (CAPTCHA_STATUS.has(status)) return 'captcha'
  const msg = String(data.msg ?? data.message ?? '')
  if (/验证码|安全验证|人机验证|请完成验证|captcha/i.test(msg)) return 'captcha'
  if (/操作[^，。；\s]{0,2}频繁|请求[^，。；\s]{0,2}频繁|访问[^，。；\s]{0,2}频繁|稍后再试|限流|限制访问|too many/i.test(msg)) return 'ratelimit'
  // 有些接口把风控信息塞在 result 里
  const r = data.result
  if (isObj(r) && (r.show_captcha === 1 || r.show_captcha === true || r.need_captcha === 1)) return 'captcha'
  return ''
}

const jitter = (gap) => Math.round(gap * (0.8 + Math.random() * 0.4))

/**
 * 小黑盒 HTTP 客户端。分档限速 + 风控冷却，写请求永不自动重试。
 * @param {object} opts
 * @param {string} opts.cookie 整串 Cookie（pkey + x_xhh_tokenid）
 * @param {number} [opts.interval] 默认档最小间隔（毫秒）
 * @param {number} [opts.timeout] 单请求超时（毫秒）
 * @param {object} [opts.risk] 冷却状态的初值（从磁盘恢复）
 * @param {(risk:object)=>void} [opts.onRisk] 冷却状态变化时回调（落盘用）
 */
export class HeyboxClient {
  constructor({ cookie = '', interval = DEFAULT_GAP, timeout = 25000, risk = null, onRisk = null } = {}) {
    this.cookie = cookie
    this.interval = interval
    this.timeout = timeout
    this.lastAt = 0
    this.calls = 0
    // 风控冷却状态：{ level, until, reason, at }
    this.risk = isObj(risk) ? { level: Number(risk.level) || 0, until: Number(risk.until) || 0, reason: String(risk.reason || ''), at: Number(risk.at) || 0 } : { level: 0, until: 0, reason: '', at: 0 }
    this.onRisk = typeof onRisk === 'function' ? onRisk : null
    this.now = () => Date.now()
  }

  get loggedIn() {
    return /pkey=|user_pkey=/.test(this.cookie)
  }

  /** 从 Cookie 里取 heybox_id（网页端每个请求都会带上它，缺了会被当成未登录） */
  get heyboxId() {
    const m = String(this.cookie || '').match(/heybox_id=(\d+)/)
    return m ? m[1] : ''
  }

  /** 冷却中？返回剩余毫秒，0 表示没在冷却 */
  cooldownLeft() {
    const left = Number(this.risk.until) - this.now()
    return left > 0 ? left : 0
  }

  /** 冷却状态快照（给面板看） */
  riskInfo() {
    return { level: this.risk.level, until: this.risk.until, reason: this.risk.reason, at: this.risk.at, leftMs: this.cooldownLeft() }
  }

  /** 进入（或加深）冷却。冷却期内所有请求直接短路，不再打小黑盒。 */
  escalate(reason = 'captcha') {
    const level = Math.min(COOLDOWN_STEPS.length, Math.max(1, this.risk.level + 1))
    const until = this.now() + COOLDOWN_STEPS[level - 1]
    this.risk = { level, until, reason, at: this.now() }
    try { this.onRisk?.(this.riskInfo()) } catch { /* 落盘失败不影响请求 */ }
    return this.riskInfo()
  }

  /** 人工验证通过 / 成功一段时间后回调冷却等级 */
  clearRisk() {
    if (this.risk.level === 0 && !this.risk.until) return this.riskInfo()
    this.risk = { level: 0, until: 0, reason: '', at: this.now() }
    try { this.onRisk?.(this.riskInfo()) } catch { /* 同上 */ }
    return this.riskInfo()
  }

  gapOf(path, method) {
    const hit = TIERS.find((t) => t.re.test(String(path || '')))
    const base = hit ? hit.gap : this.interval
    return method !== 'GET' ? Math.max(base, WRITE_GAP) : base
  }

  async #throttle(path, method) {
    const want = jitter(this.gapOf(path, method))
    const wait = want - (this.now() - this.lastAt)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    this.lastAt = this.now()
    this.calls += 1
  }

  /**
   * 发一个请求，返回解析好的 data（status=ok 才有值）。
   * @param {object} req
   * @param {string} req.path
   * @param {object} [req.params] 业务参数
   * @param {string} [req.method] GET（默认）/ POST
   * @param {object} [req.body] POST 表单
   * @param {boolean} [req.workshop] 写接口附加 _rnd
   * @param {boolean} [req.captureCookies] 需要读 Set-Cookie
   */
  async request({ path, params = {}, method = 'GET', body, workshop = false, signed = true, captureCookies = false } = {}) {
    if (!path || !path.startsWith('/')) throw new HeyboxError('path 必须以 / 开头', 'input')
    if (method !== 'GET' && !this.loggedIn) throw new HeyboxError('写操作需要登录：先在面板里填 Cookie', 'auth')

    // 冷却期直接不碰网络：这时候再发请求只会把风控拖得更久
    const left = this.cooldownLeft()
    if (left > 0) {
      throw new HeyboxError(`小黑盒在冷却中（还要等 ${Math.ceil(left / 60000)} 分钟）：${this.risk.reason || '被风控挡过'}`, 'cooldown', { leftMs: left, risk: this.riskInfo() })
    }

    await this.#throttle(path, method)

    const query = { ...BASE_PARAMS }
    // 网页端每个请求都带 heybox_id，缺了会被当成未登录
    if (this.heyboxId) query.heybox_id = this.heyboxId
    Object.assign(query, params)
    if (signed) Object.assign(query, signParams(path, { workshop }))

    const url = new URL(API_BASE + path)
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue
      url.searchParams.set(k, String(v))
    }

    const headers = {
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: WEB_BASE + '/',
      origin: WEB_BASE,
    }
    if (this.cookie) headers.cookie = this.cookie

    let payload
    if (body !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
      const form = new URLSearchParams()
      for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) form.set(k, String(v))
      payload = form.toString()
    }

    let res
    try {
      res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(this.timeout) })
    } catch (err) {
      throw new HeyboxError(`网络请求失败：${err?.message ?? err}`, 'network')
    }

    if (res.status === 429) {
      this.escalate('ratelimit')
      throw new HeyboxError('小黑盒限流（429）：已停手，冷却期内不再请求', 'rate_limit', { risk: this.riskInfo() })
    }
    if (res.status === 401 || res.status === 403) throw new HeyboxError('小黑盒返回 401/403：登录态可能失效', 'auth')

    let data
    try {
      data = await res.json()
    } catch {
      // HTML 响应基本就是被拦到验证/拦截页了
      throw new HeyboxError(`响应不是 JSON（HTTP ${res.status}）：多半被挡到验证页了`, 'protocol')
    }

    const setCookies = typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    const wrap = (v) => (captureCookies ? { data: v, setCookies } : v)

    if (!res.ok) throw new HeyboxError(`HTTP ${res.status}：${data?.msg ?? data?.message ?? '未知错误'}`, 'http', { status: res.status })

    const status = data?.status
    const risk = riskOf(data, status)
    if (risk) {
      const info = this.escalate(risk)
      const why = risk === 'captcha' ? '小黑盒要求安全验证' : '小黑盒判定操作太频繁'
      throw new HeyboxError(`${why}（${status ?? 'risk'}）：已停手，冷却 ${Math.ceil((info.until - this.now()) / 60000)} 分钟。需要时去面板点「去验证」用浏览器过一次`, 'captcha', { risk: info })
    }
    if (status === 'ok') {
      // 冷却早已到期、这次又成功了：说明风控松了，正式解除（走 clearRisk 才会落盘）
      if (this.risk.level > 0 && this.now() > this.risk.until) this.clearRisk()
      return wrap(data)
    }
    if (AUTH_STATUS.has(status)) throw new HeyboxError(`登录态失效（${status}）：请重新登录`, 'auth')
    throw new HeyboxError(`小黑盒拒绝（${status ?? 'no-status'}）：${data?.msg ?? ''}`.trim(), 'api', { payload: data })
  }

  get(path, params) { return this.request({ path, params }) }
  post(path, body, params) { return this.request({ path, params, method: 'POST', body, workshop: true }) }

  /** PUT 到 COS（不走小黑盒签名） */
  async putCOS(url, buf, { contentType, authorization, sessionToken }) {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': contentType, authorization, 'x-cos-security-token': sessionToken, 'user-agent': UA },
      body: buf,
      signal: AbortSignal.timeout(60000),
    })
    if (res.status !== 200 && res.status !== 204) throw new HeyboxError(`COS 直传失败 HTTP ${res.status}`, 'network')
    return true
  }
}
