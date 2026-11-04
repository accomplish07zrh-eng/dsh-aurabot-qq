// 文字 → 语音文件。
//   首选：edge-tts（微软在线朗读，音色好），装在插件自己的 Python 虚拟环境 C:\Aurabot\pyenv 里，不污染系统。
//   兜底：Windows 自带的中文语音（System.Speech / Huihui），什么都不装也能用（只有 Windows 有）。
// 管线：文字 → TTS → 文件路径。任何一步失败由调用方退回发文字。（RVC 音色目前用在翻唱上，见 src/song/）

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { buildWav } from './wav.js'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { dataDir } from '../core/store.js'

// edge-tts 的私有 Python 环境，一键安装时自动创建。老安装沿用 C:\Aurabot\pyenv；新安装放在用户目录下
const LEGACY_PYENV = 'C:\\Aurabot\\pyenv'
export const PYENV_DIR = process.env.AURABOT_PYENV || (existsSync(LEGACY_PYENV) ? LEGACY_PYENV : join(homedir(), 'Aurabot', 'pyenv'))
const WIN = process.platform === 'win32'
// 虚拟环境的目录结构 Windows 和 Linux / macOS 不一样
const pyExe = () => (WIN ? join(PYENV_DIR, 'Scripts', 'python.exe') : join(PYENV_DIR, 'bin', 'python'))

function run(cmd, args, { timeoutMs = 60000, input, env } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...(env || {}) } })
    } catch (error) {
      resolve({ code: -1, out, err: error.message })
      return
    }
    const t = setTimeout(() => {
      try { child.kill() } catch (e) {}
      err += '\n超时'
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { err += e.message })
    child.on('close', (code) => {
      clearTimeout(t)
      resolve({ code, out, err })
    })
    if (input !== undefined) {
      child.stdin.end(input, 'utf8')
    }
  })
}

function outDir() {
  const d = dataDir('voice-cache')
  mkdirSync(d, { recursive: true })
  // 顺手清掉一天前的旧文件
  try {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (Date.now() - statSync(p).mtimeMs > 86400_000) unlinkSync(p)
    }
  } catch (error) {}
  return d
}

export function edgeInstalled() {
  if (!existsSync(pyExe())) return false
  if (WIN) return existsSync(join(PYENV_DIR, 'Lib', 'site-packages', 'edge_tts'))
  try {
    return readdirSync(join(PYENV_DIR, 'lib')).some((v) => v.startsWith('python') && existsSync(join(PYENV_DIR, 'lib', v, 'site-packages', 'edge_tts')))
  } catch (error) {
    return false
  }
}

/** 面板「安装语音组件」：建虚拟环境并 pip 安装 edge-tts（开源，LGPL）。 */
export async function installEdge(log) {
  mkdirSync(PYENV_DIR, { recursive: true })
  if (!existsSync(pyExe())) {
    // 电脑上有 Python 就直接用；没有就用 uv 下一个私有的 Python（不用用户自己装）
    let r = WIN ? await run('py', ['-3', '-m', 'venv', PYENV_DIR], { timeoutMs: 180000 }) : { code: -1 }
    if (r.code !== 0) r = await run('python3', ['-m', 'venv', PYENV_DIR], { timeoutMs: 180000 })
    if (r.code !== 0) r = await run('python', ['-m', 'venv', PYENV_DIR], { timeoutMs: 180000 })
    if (r.code !== 0) {
      log?.info('电脑上没有可用的 Python，用 uv 准备一个私有的')
      const uv = await findOrFetchUv(log)
      if (!uv) return { ok: false, message: WIN ? '准备 Python 失败：下载安装工具 uv 没成功，检查一下网络（开代理或换个网络）再试' : '准备 Python 失败：电脑上没有能建虚拟环境的 Python（Debian / Ubuntu 装一下 python3-venv），也没有 uv（curl -LsSf https://astral.sh/uv/install.sh | sh）' }
      const env = { UV_PYTHON_INSTALL_DIR: join(dirname(PYENV_DIR), 'python'), UV_PYTHON_INSTALL_MIRROR: 'https://registry.npmmirror.com/-/binary/python-build-standalone' }
      r = await run(uv, ['venv', '-q', PYENV_DIR, '--python', '3.12'], { timeoutMs: 600000, env })
      if (r.code !== 0) return { ok: false, message: '准备 Python 失败：' + r.err.slice(-300) }
    }
  }
  log?.info('正在安装 edge-tts …')
  let r = await run(pyExe(), ['-m', 'pip', 'install', '-q', 'edge-tts'], { timeoutMs: 300000 })
  if (r.code !== 0) {
    r = await run(pyExe(), ['-m', 'pip', 'install', '-q', '-i', 'https://mirrors.aliyun.com/pypi/simple', 'edge-tts'], { timeoutMs: 300000 })
  }
  // uv 建的环境里没有 pip：改用 uv 装
  if (r.code !== 0 && /No module named pip/.test(r.err)) {
    const uv = await findOrFetchUv(log)
    if (uv) {
      r = await run(uv, ['pip', 'install', '-q', '--python', pyExe(), 'edge-tts'], { timeoutMs: 300000 })
      if (r.code !== 0) r = await run(uv, ['pip', 'install', '-q', '--python', pyExe(), '--default-index', 'https://mirrors.aliyun.com/pypi/simple', 'edge-tts'], { timeoutMs: 300000 })
    }
  }
  if (r.code !== 0) return { ok: false, message: '安装 edge-tts 失败：' + r.err.slice(-300) }
  return { ok: true, message: '语音组件装好了' }
}

/** 找 uv：电脑上有就用，翻唱装过的也能用，都没有就下一个（走系统代理）。 */
async function findOrFetchUv(log) {
  if (process.env.AURABOT_UV) return process.env.AURABOT_UV
  if ((await run('uv', ['--version'], { timeoutMs: 15000 })).code === 0) return 'uv'
  // Linux / macOS：只找装好的（官方安装脚本默认放 ~/.local/bin 或 ~/.cargo/bin），不自动下载
  if (!WIN) return [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv')].find((p) => existsSync(p)) || ''
  const local = join(dirname(PYENV_DIR), 'bin', 'uv.exe')
  for (const p of [local, join('C:\\Aurabot', 'rvc', 'bin', 'uv.exe'), join(homedir(), 'Aurabot', 'rvc', 'bin', 'uv.exe')]) if (existsSync(p)) return p
  log?.info('下载 uv …')
  const zip = join(dirname(PYENV_DIR), 'bin', 'uv.zip')
  const tmp = join(dirname(PYENV_DIR), 'bin', 'uv-src')
  mkdirSync(dirname(zip), { recursive: true })
  // 和翻唱安装用同一组下载源：国内镜像上的 uv 安装包优先，最后才试 GitHub；有校验值的核对一下
  const { UV_SOURCES } = await import('../song/studio.js')
  const ps = "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri $env:AB_URL -OutFile $env:AB_OUT -UseBasicParsing -TimeoutSec 300; if ($env:AB_SHA -and (Get-FileHash $env:AB_OUT -Algorithm SHA256).Hash.ToLower() -ne $env:AB_SHA) { throw 'sha256 mismatch' }; if (Test-Path $env:AB_TMP) { Remove-Item $env:AB_TMP -Recurse -Force }; Expand-Archive -LiteralPath $env:AB_OUT -DestinationPath $env:AB_TMP -Force; $e = Get-ChildItem $env:AB_TMP -Recurse -Filter uv.exe | Select-Object -First 1; Copy-Item $e.FullName $env:AB_DEST -Force; Remove-Item $env:AB_OUT; Remove-Item $env:AB_TMP -Recurse -Force"
  for (const src of UV_SOURCES) {
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 400000, env: { AB_URL: src.url, AB_OUT: zip, AB_TMP: tmp, AB_DEST: local, AB_SHA: src.sha256 || '' } })
    if (r.code === 0 && existsSync(local)) return local
    log?.info(`从 ${new URL(src.url).host} 下 uv 没成功，换一个源`)
  }
  return existsSync(local) ? local : ''
}

async function edgeSynth(text, voice, rate, pitch) {
  const file = join(outDir(), `${randomUUID()}.mp3`)
  // 文字走 stdin 的临时文件，避免命令行里的引号 / 编码问题
  const txt = join(outDir(), `${randomUUID()}.txt`)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(txt, text, 'utf8')
  const args = ['-I', '-m', 'edge_tts', '--voice', voice, '--file', txt, '--write-media', file]
  if (rate && rate !== '+0%') args.push(`--rate=${rate}`)
  if (pitch && pitch !== '+0Hz') args.push(`--pitch=${pitch}`)
  const r = await run(pyExe(), args, { timeoutMs: 60000 })
  try { unlinkSync(txt) } catch (error) {}
  if (r.code !== 0 || !existsSync(file) || statSync(file).size < 500) {
    throw new Error('edge-tts 失败：' + (r.err || r.out).slice(-200))
  }
  return file
}

async function windowsSynth(text) {
  const file = join(outDir(), `${randomUUID()}.wav`)
  const script =
    'Add-Type -AssemblyName System.Speech;' +
    '$t=[Console]::In.ReadToEnd();' +
    '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;' +
    "$zh=$s.GetInstalledVoices()|Where-Object{$_.VoiceInfo.Culture.Name -eq 'zh-CN'}|Select-Object -First 1;" +
    'if($zh){$s.SelectVoice($zh.VoiceInfo.Name)};' +
    `$s.SetOutputToWaveFile('${file.replace(/'/g, "''")}');$s.Speak($t);$s.Dispose()`
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::InputEncoding=[Text.Encoding]::UTF8;${script}`], { timeoutMs: 60000, input: text })
  if (!existsSync(file) || statSync(file).size < 1000) throw new Error('Windows 语音失败：' + r.err.slice(-200))
  return file
}

// ---------- 本地 / 自建 TTS 服务（地址是主人自己填的，所以允许 127.0.0.1） ----------

async function fetchAudio(url, init, timeoutMs = 120000) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`HTTP ${r.status}：${(await r.text().catch(() => '')).slice(0, 120)}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length < 400) throw new Error('返回的音频太短：' + buf.toString('utf8').slice(0, 120))
  return buf
}

function saveAudio(buf, sampleRate) {
  const isWav = buf.toString('ascii', 0, 4) === 'RIFF'
  const isMp3 = buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
  const isOgg = buf.toString('ascii', 0, 4) === 'OggS'
  let out = buf
  let ext = isWav ? 'wav' : isMp3 ? 'mp3' : isOgg ? 'ogg' : 'wav'
  // 裸 PCM16（CosyVoice 官方 FastAPI 就是这样流式返回的）：包一个 WAV 头
  if (!isWav && !isMp3 && !isOgg) out = buildWav(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)), sampleRate)
  const file = join(outDir(), `${randomUUID()}.${ext}`)
  writeFileSync(file, out)
  return file
}

/** CosyVoice 官方 runtime/python/fastapi：/inference_sft（tts_text, spk_id）、/inference_instruct（再加 instruct_text）。 */
async function cosyvoiceSynth(text, c) {
  const base = String(c.url || '').replace(/\/+$/, '')
  if (!base) throw new Error('没填 CosyVoice 地址')
  const instruct = c.mode === 'instruct' && c.instruct
  const form = new URLSearchParams({ tts_text: text, spk_id: c.spkId || '中文女' })
  if (instruct) form.set('instruct_text', c.instruct)
  const buf = await fetchAudio(`${base}/${instruct ? 'inference_instruct' : 'inference_sft'}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form })
  return saveAudio(buf, c.sampleRate || 22050)
}

/** GPT-SoVITS api_v2：GET /tts?text=…&text_lang=zh&ref_audio_path=…&prompt_text=…&prompt_lang=zh */
async function gptsovitsSynth(text, c) {
  const base = String(c.url || '').replace(/\/+$/, '')
  if (!base) throw new Error('没填 GPT-SoVITS 地址')
  const q = new URLSearchParams({ text, text_lang: c.textLang || 'zh', ref_audio_path: c.refAudio || '', prompt_text: c.promptText || '', prompt_lang: c.promptLang || 'zh', media_type: 'wav' })
  return saveAudio(await fetchAudio(`${base}/tts?${q}`, { method: 'GET' }), 32000)
}

/** 请求头文本 → 对象。一行一个「Key: Value」，空行和 # 开头的行忽略。 */
function parseHeaderText(raw) {
  const out = {}
  for (const line of String(raw || '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf(':')
    if (i <= 0) continue
    const k = s.slice(0, i).trim()
    const v = s.slice(i + 1).trim()
    if (k && v) out[k] = v
  }
  return out
}

/** 云厂商把音频塞在 JSON 里（base64），这里把常见的几种字段扒出来。 */
function pickAudioFromJson(obj) {
  if (!obj || typeof obj !== 'object') return ''
  const keys = ['data', 'audio', 'audio_base64', 'audioBase64', 'base64', 'voice', 'result']
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.length > 200) return v
    if (v && typeof v === 'object') {
      const inner = pickAudioFromJson(v)
      if (inner) return inner
    }
  }
  return ''
}

/**
 * 通用 HTTP：自己填地址、请求头、请求体。
 * GET  —— 地址里带 {text}
 * POST —— 地址填接口地址，请求体里带 {text}（按 JSON 字符串转义），也可用 {text_raw} 不转义
 * 返回二进制音频，或者 JSON（自动从 data / audio 等字段取 base64 解开）。
 */
export async function httpSynth(text, c) {
  const url = String(c.urlTemplate || '').trim()
  if (!url) throw new Error('通用 TTS 没填地址')
  const method = String(c.method || 'GET').trim().toUpperCase()
  const headers = parseHeaderText(c.headers)
  const hasHeader = (name) => Object.keys(headers).some((k) => k.toLowerCase() === name)

  let target = url
  let body
  if (method === 'GET' || method === 'HEAD') {
    if (!url.includes('{text}')) throw new Error('GET 方式的地址里要有 {text}')
    target = url.split('{text}').join(encodeURIComponent(text))
  } else {
    const raw = String(c.body || '').trim()
    if (!raw) throw new Error(`${method} 方式要填请求体`)
    const escaped = JSON.stringify(text).slice(1, -1)
    body = raw.split('{text}').join(escaped).split('{text_raw}').join(text).split('{reqid}').join(randomUUID())
    if (!hasHeader('content-type')) headers['content-type'] = 'application/json'
  }

  const r = await fetch(target, { method, headers, body, signal: AbortSignal.timeout(120000) })
  if (!r.ok) throw new Error(`HTTP ${r.status}：${(await r.text().catch(() => '')).slice(0, 160)}`)

  let buf = Buffer.from(await r.arrayBuffer())
  const ctype = String(r.headers.get('content-type') || '')
  const looksJson = ctype.includes('json') || buf[0] === 0x7b
  if (looksJson) {
    let parsed = null
    try { parsed = JSON.parse(buf.toString('utf8')) } catch (error) {}
    if (!parsed) throw new Error('返回的是 JSON 但解析失败：' + buf.toString('utf8').slice(0, 160))
    const code = parsed.code ?? parsed.status ?? parsed.retcode
    const b64 = pickAudioFromJson(parsed)
    if (!b64) {
      throw new Error(`返回里没找到音频数据（code=${code}，message=${parsed.message || parsed.msg || parsed.err_msg || '-'}）`)
    }
    buf = Buffer.from(b64, 'base64')
  }
  if (buf.length < 400) throw new Error('返回的音频太短：' + buf.toString('utf8').slice(0, 160))
  return saveAudio(buf, c.sampleRate || 24000)
}

// ---------------------------------------------------------------- 豆包语音（火山引擎）预设
// 地址、请求头、请求体全部写死在这里，面板上只让人填 API Key、选音色。
// 坑：v3 接口返回的不是一个 JSON，是「一堆 JSON 首尾相连」（音频一块一块放在 data 里，
// 最后一段 code=20000000 表示结束）。所以不能 JSON.parse 整段，得一段段扒出来拼回去。

// 走代理网关或自测时可以用环境变量指到别的地方
const VOLCANO_URL = process.env.AURABOT_VOLCANO_URL || 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'

/** 按大括号配平，从一串连着的 JSON 里切出每个完整对象。 */
function splitJsonObjects(raw) {
  const out = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') { if (depth === 0) start = i; depth++ }
    else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) { out.push(raw.slice(start, i + 1)); start = -1 }
    }
  }
  return out
}

/** 音色 id → 模型版本。2.0 音色 id 里带 uranus，其余都是 1.0；混用会报 speaker permission denied。 */
export function volcanoResourceFor(voiceType) {
  return /uranus/i.test(String(voiceType || '')) ? 'seed-tts-2.0' : 'seed-tts-1.0'
}

/** 火山的错误码翻成人话，直接显示在面板/日志上。 */
function volcanoHint(code, message) {
  const m = String(message || '')
  const n = Number(code) || 0
  // 这个码不只代表「填错」：刚开通语音合成、或者刚建的 Key，火山要过几分钟才认，也会回它
  if (n === 45000010 || /Invalid X-Api-Key/i.test(m)) return 'API Key 没被认出来：先确认是「语音技术 → 设置 → API Key」页复制的（方舟/大模型的 Key 不通用）、没被禁用；刚开通服务或刚建 Key 的话，等几分钟再试一次'
  // 1.0 和 2.0 是两个产品，只开通一个的话，换到另一种音色就会撞上这条
  if (n === 45000030 || /resource not granted/i.test(m)) return '这个音色要的模型没开通（45000030）：id 带 uranus 的是 2.0，带 moon / mars 的是 1.0，两种要在「开通管理」里分别开通。账号只开了一个的话，换回另一种音色，或者去控制台把另一个也开了（开通后等几分钟生效）'
  if (n === 55000000 || /mismatched with speaker/i.test(m)) return '音色和模型版本对不上：id 里带 uranus / vv 的要配 seed-tts-2.0，带 moon / mars 的配 seed-tts-1.0'
  if (n === 40402003 || /TTSExceededTextLimit/i.test(m)) return '这段文字太长，火山一次念不完，拆成几段发'
  if (/concurrency|quota/i.test(m)) return '火山的并发额度用完了，等几秒再试'
  return ''
}

export async function volcanoSynth(text, c) {
  const apiKey = String(c.apiKey || '').trim()
  if (!apiKey) throw new Error('豆包语音：还没填 API Key')
  const speaker = String(c.voiceType || 'zh_female_vv_uranus_bigtts')
  // 音色和模型版本必须配对，所以没显式指定时就按音色自己认：id 带 uranus 的是 2.0，其余是 1.0
  const resourceId = String(c.resourceId || '').trim() || volcanoResourceFor(speaker)
  const speed = Number(c.speedRatio) || 1

  const audioParams = { format: 'mp3', sample_rate: 24000 }
  // 语速 1.0 就不传，省得某些音色不认这个字段
  if (Math.abs(speed - 1) > 0.001) audioParams.speech_rate = Math.round((speed - 1) * 100)

  const r = await fetch(VOLCANO_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': randomUUID(),
    },
    body: JSON.stringify({
      user: { uid: 'aurabot' },
      req_params: { text, speaker, audio_params: audioParams },
    }),
    signal: AbortSignal.timeout(120000),
  })

  const raw = await r.text()
  if (!r.ok) {
    let j = null
    try { j = JSON.parse(raw) } catch (e) {}
    const code = (j && j.header && j.header.code) || (j && j.code)
    const msg = (j && j.header && j.header.message) || (j && j.message) || raw
    throw new Error(volcanoHint(code, msg) || `豆包语音 HTTP ${r.status}：${String(msg).slice(0, 160)}`)
  }

  const parts = []
  let firstError = ''
  for (const seg of splitJsonObjects(raw)) {
    let j = null
    try { j = JSON.parse(seg) } catch (e) { continue }
    const h = j.header && typeof j.header === 'object' ? j.header : j
    const code = h.code
    // 0 = 音频块，20000000 = 结束；别的码都算失败
    if (code && code !== 0 && code !== 20000000 && !firstError) firstError = `${code} ${h.message || ''}`
    if (typeof j.data === 'string' && j.data.length > 20) parts.push(Buffer.from(j.data, 'base64'))
  }

  if (!parts.length) {
    const sp = firstError.indexOf(' ')
    const code = sp > 0 ? firstError.slice(0, sp) : '0'
    const msg = sp > 0 ? firstError.slice(sp + 1) : firstError
    throw new Error(volcanoHint(code, msg) || `豆包语音没返回音频：${raw.slice(0, 160)}`)
  }

  const buf = Buffer.concat(parts)
  if (buf.length < 400) throw new Error('豆包语音返回的音频太短：' + raw.slice(0, 160))
  return saveAudio(buf, 24000)
}

/** 说话语音的后处理：目前原样返回（RVC 换音色只用在翻唱上，语音条直接用 TTS 的声音）。 */
export const voiceConverters = []

/**
 * @returns {Promise<{file:string, engine:string}>}
 */
export async function textToSpeech(text, opt = {}, log) {
  const clean = String(text || '').trim()
  if (!clean) throw new Error('没有要念的文字')
  let file = ''
  let engine = ''
  const local = { cosyvoice: cosyvoiceSynth, gptsovits: gptsovitsSynth, http: httpSynth, volcano: volcanoSynth }[opt.engine]
  if (local) {
    try {
      file = await local(clean, opt[opt.engine] || {})
      engine = opt.engine
    } catch (error) {
      log?.warn(`${opt.engine} 失败：${error.message} → 改用 Windows 语音`)
    }
  } else if (opt.engine !== 'windows' && edgeInstalled()) {
    try {
      file = await edgeSynth(clean, opt.voice || 'zh-CN-XiaoyiNeural', opt.rate, opt.pitch)
      engine = 'edge'
    } catch (error) {
      log?.warn(error.message, '→ 改用 Windows 语音')
    }
  }
  if (!file) {
    if (!WIN) throw new Error('语音没合成出来：Linux / macOS 上没有 Windows 自带语音可以兜底，先在「语音」页装好 edge-tts，或者用本地 TTS 服务')
    file = await windowsSynth(clean)
    engine = 'windows'
  }
  for (const conv of voiceConverters) {
    try {
      file = await conv(file)
    } catch (error) {
      log?.warn('变声失败，用原声：', error.message)
    }
  }
  return { file, engine }
}
