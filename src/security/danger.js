// 危险终端命令确认（可选保护，默认关）：
// 打开后，她在主人私聊里要执行「删根目录 / 格式化 / 关机 / 下载后直接执行」这类命令时，
// 插件先不发出去，而是给主人 QQ 发一条确认消息；主人回复「确认」才放行，
// 回复「取消」或超时（60 秒）就拦下，并把她实际要执行的命令如实告诉模型。
//
// 为什么放在 tools/pre-execute 这一层：DSH 在工具真正执行前会走这个 waterfall，
// 这里返回 deny 就不会执行，能拿到「命令原文」，比只靠提示词可靠。

import { isOwner } from '../chat/access.js'

const CONFIRM_RE = /^(确认|确认执行|同意|同意执行|允许|允许执行|可以|执行吧|放行|yes|y|ok)$/i
const CANCEL_RE = /^(取消|取消执行|拒绝|不要|不|不行|别|停|停手|拦下|no|n)$/i

/**
 * 危险命令规则分两层：
 *
 * 1) EXEC_RULES —— 「执行型」规则（rm -rf、写裸盘、下载后执行……）。直接在「剥掉 heredoc /
 *    here-string 正文、但保留引号内容」的命令文本上跑。它们本来就要匹配参数里的路径，不能
 *    简单按命令位置判断；heredoc 里写笔记提到它们已在预处理阶段被剥掉。
 * 2) 命令位置规则 —— `mkfs`/`fdisk`/`shutdown` 这类「提到这个词就危险」的规则，只在它真的
 *    出现在命令位置（行首，或 ; && || | ( ) 换行之后，允许 sudo/env 等前缀）时才算；
 *    `echo "mkfs 是危险的"`、`printf "...wipefs..."` 这种只是提及，不再误拦。
 *
 * 预处理（stripNoise）：
 * - 剥 bash heredoc 正文（<<EOF / <<'EOF' / <<-EOF 到终止行）；
 * - 剥 PowerShell here-string（@'…'@ / @"…"@）；
 * - 解析不平衡（heredoc/here-string 没闭合）时返回 null，调用方按原文做原规则匹配
 *   —— 解析不确定就宁可多拦，保持 fail-closed。
 *
 * 「宁少勿多」：只处理已知误伤，不扩大拦截面。
 */
const EXEC_RULES = [
  { label: '递归删除根目录/盘符', re: /\brm\s+-[a-z]*(?:rf|fr)[a-z]*\s+(?:\/|~|\$HOME|[a-zA-Z]:[\\/])(?:\s|$|\*)/i },
  { label: '递归删除根目录/盘符', re: /\bRemove-Item\b[^\n]*(-Recurse|-r\b)[^\n]*(-Force|-fo\b)?[^\n]*["']?(?:[a-zA-Z]:[\\/]|\/(?:\s|$)|~)/i },
  { label: '递归删除盘符', re: /\b(?:del|erase)\s+(?:\/[a-z]+\s+)*[a-zA-Z]:[\\/]?(\s|$|\*)/i },
  { label: '递归删除目录', re: /\b(?:rd|rmdir)\s+\/[a-z]*s[a-z]*\s+[a-zA-Z]:[\\/]/i },
  { label: '下载后直接执行', re: /(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z|k|da)?sh\b/i },
  { label: '下载后直接执行', re: /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*(?:\||>)[^\n]*(?:iex|Invoke-Expression)\b/i },
  // 只拦「往裸块设备写」。原来的 /\bdd\s+if=/ 认的是 dd 的**输入**，跟写盘无关，于是
  // `dd if=/dev/zero of=/dev/null`（测速）、`dd if=/dev/sda of=/tmp/x.img`（只读备份）都被
  // 拦了；而真正危险的逆序写法 `dd of=/dev/sda if=...` 反倒因为不匹配 dd\s+if= 漏掉了。
  { label: '直接写磁盘', re: /\bdd\b[^\n]*?\bof=\s*["']?\/dev\/(?:sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|mmcblk\d|md\d|dm-\d|disk\/|mapper\/)/i },
  { label: '直接写磁盘', re: />\s*\/dev\/(?:sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|mmcblk\d|md\d|dm-\d|disk\/|mapper\/)/i },
  { label: '提权/改管理员组', re: /\bnet\s+(?:user\s+\S+\s+\S+\s+\/add|localgroup\s+(?:administrators|admin)\b)/i },
  { label: '强制改系统目录权限', re: /\b(?:takeown|icacls)\s+[^\n]*(?:[a-zA-Z]:\\Windows|\/etc|\/usr|\/bin)\b/i },
  { label: 'chmod 根目录', re: /\bchmod\s+-R\s+777\s+\/(?:\s|$)/i },
  { label: 'forkshell 炸弹', re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/ },
]

/** 只在命令位置才算的危险命令词。 */
const MENTION_WORDS = {
  '清空磁盘/分区': new Set(['mkfs', 'mke2fs', 'fdisk', 'parted', 'diskpart', 'wipefs']),
  '关闭/重启电脑': new Set(['shutdown', 'stop-computer', 'restart-computer', 'reboot', 'halt', 'poweroff']),
}

// Aurabot 自己的模块目录：变量赋值、管道删除、Move/Rename 都可能绕过
// 「Remove-Item 后面必须跟绝对路径」的通用规则。只要同一条命令里同时出现
// 受保护路径和删除/移动动作，就要求主人确认，宁可多问一次。
const AURABOT_MODULES_PATH_RE = /plugins-data[\\/]+aurabot[\\/]+modules(?:-data)?(?:[\\/]|["'\s;]|$)/i
const AURABOT_MODULES_ACTION_RE = /\b(?:Remove-Item|Move-Item|Rename-Item|rm|del|erase|rd|rmdir|mv|move|ren|rename)\b/i
const AURABOT_MODULES_DANGER = '删除/移动 Aurabot 模块目录'
function touchesAurabotModules (text) {
  return AURABOT_MODULES_PATH_RE.test(text) && AURABOT_MODULES_ACTION_RE.test(text)
}

/** parted 的只读形式：只要同一段里没有写操作子命令，就放行。 */
const PARTED_READ_ONLY = new Set(['-l', '--list', '-p', 'print', '--pretend'])
const PARTED_WRITE = new Set(['mklabel', 'mkpart', 'mkpartfs', 'mkfs', 'mkswap', 'rm', 'resizepart', 'resize', 'set', 'toggle', 'name', 'flag', 'disk_set', 'disk_toggle', 'select', 'rescue', 'align-check'])

const TOKEN_RE = /(?:[^\s"'`]+|"(?:[^"\\]|\\.)*"|'[^']*'|`(?:[^`\\]|\\.)*`)/g

/** 去掉最外层一层引号（tokenizer 保留引号）。 */
function unquote (s) {
  const t = String(s == null ? '' : s)
  if (t.length >= 2) {
    const a = t[0]
    if ((a === '"' || a === "'" || a === '`') && t[t.length - 1] === a) {
      const body = t.slice(1, -1)
      // 双引号里的 " 是引号转义，恢复回来再交给下一层扫描（bash -c "bash -c \"…\""）
      return a === '"' ? body.replace(/\\"/g, '"') : body
    }
  }
  return t
}

/** 命令名取 basename、转小写（兼容 /usr/bin/mkfs、C:\Windows\system32\format.exe）。 */
function baseName (s) {
  return unquote(s).replace(/^.*[\\/]/, '').toLowerCase()
}

/** 按 shell 分隔符切段，尊重引号；不切重定向 `>`，免得 `cat x > /dev/sda` 被拆散。 */
function splitSegments (text) {
  const out = []
  let cur = ''
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      cur += ch
      if (ch === '\\' && quote === '"') {
        if (i + 1 < text.length) cur += text[++i]
        continue
      }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue }
    if ('\n;|&()'.includes(ch)) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out
}

/** 命令前的修饰词：跳过它们继续找真正的命令。 */
const PREFIX_WORDS = new Set(['sudo', 'doas', 'env', 'nohup', 'command', 'builtin', 'exec', 'time', 'timeout', 'nice', 'ionice', 'stdbuf', 'chrt', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{'])
const PREFIX_ARG_FLAGS = {
  sudo: new Set(['-u', '-g', '-p', '-c', '-C', '-h', '-r', '-t', '-U', '-T', '-D', '-R']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p', '-u', '--class', '--classdata']),
  stdbuf: new Set(['-i', '-o', '-e']),
  chrt: new Set(['-p', '-P', '-T', '-D']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  time: new Set(['-f', '-o', '--format', '--output']),
}

/** tokens 里第一个「真正执行命令」的下标；跳过 sudo/env 等前缀和变量赋值。 */
function commandIndex (tokens) {
  let i = 0
  while (i < tokens.length) {
    const raw = tokens[i]
    const base = baseName(raw)
    if (raw.startsWith('-')) { i++; continue }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(unquote(raw))) { i++; continue }
    if (base === 'command') {
      // command -v / -V 只是查存在，不执行
      let j = i + 1
      let lookup = false
      while (j < tokens.length && tokens[j].startsWith('-')) {
        if (tokens[j] === '-v' || tokens[j] === '-V') lookup = true
        j++
      }
      if (lookup) return -1
      i = j
      continue
    }
    if (PREFIX_WORDS.has(base)) {
      i++
      const argFlags = PREFIX_ARG_FLAGS[base]
      while (i < tokens.length) {
        const n = tokens[i]
        if (n.startsWith('-')) {
          if (argFlags && argFlags.has(n) && i + 1 < tokens.length) i += 2
          else i++
          continue
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(unquote(n))) { i++; continue }
        break
      }
      continue
    }
    return i
  }
  return -1
}

/** 命令位置规则：命中返回中文标签，不命中返回 ''。 */
function mentionHit (cmd, args) {
  const a = args.map((x) => unquote(x).toLowerCase())
  const has = (...xs) => xs.some((x) => a.includes(x))
  if (cmd === 'mkfs' || cmd.startsWith('mkfs.') || cmd === 'mke2fs' || cmd.startsWith('mke2fs.')) return '清空磁盘/分区'
  if (cmd === 'fdisk') return has('-l', '--list') ? '' : '清空磁盘/分区'
  if (cmd === 'parted') {
    if (has(...PARTED_READ_ONLY)) {
      if (!a.some((x) => PARTED_WRITE.has(x))) return ''
    }
    return '清空磁盘/分区'
  }
  if (cmd === 'diskpart') return '清空磁盘/分区'
  if (cmd === 'wipefs') {
    const noAct = has('-n', '--no-act')
    const wipe = has('-a', '--all')
    return noAct && !wipe ? '' : '清空磁盘/分区'
  }
  if (MENTION_WORDS['关闭/重启电脑'].has(cmd)) return '关闭/重启电脑'
  if (cmd === 'format' && a.some((x) => /^[a-z]:/.test(x))) return '格式化磁盘'
  if (cmd === 'reg' && has('add', 'delete') && a.some((x) => x === 'hklm' || x.startsWith('hklm\\') || x.startsWith('hkey_local_machine'))) return '改注册表关键项'
  if (cmd === 'vssadmin' && has('delete') && has('shadows')) return '删除卷影副本/引导配置'
  if (cmd === 'wbadmin' && has('delete')) return '删除卷影副本/引导配置'
  if (cmd === 'bcdedit') return '删除卷影副本/引导配置'
  return ''
}

const SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'busybox', 'pwsh', 'powershell', 'powershell.exe', 'cmd', 'cmd.exe'])
const C_FLAG_RE = /^(?:-[a-z]*c[a-z]*|\/c)$/i
const COMMAND_FLAGS = new Set(['-command', '--command', '/command', '-c', '/c'])
/** 这些命令的参数里可能还套着一条命令，尽量把内层也扫一遍。 */
const XARGS_ARG_FLAGS = new Set(['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a'])
const SSH_ARG_FLAGS = new Set(['-p', '-i', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-W', '-b', '-c', '-E', '-e', '-m', '-O', '-Q', '-S', '-w'])

/**
 * 命令替换：反引号和 $(...) 里的内容是会被执行的，递归扫一遍。
 * 单引号里的内容字面执行、不算，跳过（避免 `echo '$(mkfs)'` 这种笔记式文本误伤）。
 */
function commandSubs (text) {
  const out = []
  const raw = String(text)
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === '\\') { i++; continue }
    if (c === "'") {
      // 跳过单引号字面量
      let j = i + 1
      while (j < raw.length && raw[j] !== "'") { if (raw[j] === '\\') j++; j++ }
      i = j
      continue
    }
    if (c === '`') {
      let j = i + 1
      let buf = ''
      for (; j < raw.length; j++) {
        if (raw[j] === '\\' && j + 1 < raw.length) { buf += raw[j + 1]; j++; continue }
        if (raw[j] === '`') break
        buf += raw[j]
      }
      if (j < raw.length) { out.push(buf); i = j }
      continue
    }
    if (c === '$' && raw[i + 1] === '(') {
      let depth = 1
      let quote = ''
      let j = i + 2
      for (; j < raw.length; j++) {
        const d = raw[j]
        if (quote) {
          if (d === '\\') { j++; continue }
          if (d === quote) quote = ''
          continue
        }
        if (d === '"' || d === "'" || d === '`') { quote = d; continue }
        if (d === '(') depth++
        else if (d === ')' && --depth === 0) break
      }
      if (depth === 0) { out.push(raw.slice(i + 2, j)); i = j }
    }
  }
  return out
}

/** 跳过一组前置选项（含带参数的选项），返回第一个非选项 token 的下标。 */
function skipFlags (args, start, argFlags) {
  let i = start
  while (i < args.length) {
    const a = unquote(args[i])
    if (!a.startsWith('-')) break
    if (argFlags && argFlags.has(a) && i + 1 < args.length) i += 2
    else i++
  }
  return i
}

/** 命令位置扫描；遇到 sh -c / pwsh -Command / cmd /c 时递归扫描它的 payload。 */
function scanMentions (text, depth) {
  if (depth > 4) return ''
  // 命令替换里的内容会被真正执行：递归扫描
  for (const sub of commandSubs(text)) {
    const r = scanAll(sub, depth + 1)
    if (r) return r
  }
  for (const seg of splitSegments(text)) {
    const tokens = seg.match(TOKEN_RE) || []
    if (!tokens.length) continue
    const idx = commandIndex(tokens)
    if (idx < 0) continue
    const cmd = baseName(tokens[idx])
    const args = tokens.slice(idx + 1)
    if (SHELL_WRAPPERS.has(cmd)) {
      for (let j = 0; j < args.length; j++) {
        const flag = unquote(args[j]).toLowerCase()
        if (!C_FLAG_RE.test(flag) && !COMMAND_FLAGS.has(flag)) continue
        const payload = args.slice(j + 1).map(unquote).join(' ')
        if (payload.trim()) {
          const r = scanAll(payload, depth + 1)
          if (r) return r
        }
        break
      }
    }
    // 其他「参数里套命令」的常见写法：eval / xargs / find -exec / ssh 远端命令
    if (cmd === 'eval') {
      const payload = args.map(unquote).join(' ')
      if (payload.trim()) {
        const r = scanAll(payload, depth + 1)
        if (r) return r
      }
    }
    if (cmd === 'xargs') {
      const payload = args.slice(skipFlags(args, 0, XARGS_ARG_FLAGS)).map(unquote).join(' ')
      if (payload.trim()) {
        const r = scanAll(payload, depth + 1)
        if (r) return r
      }
    }
    if (cmd === 'find') {
      for (let j = 0; j < args.length; j++) {
        const a = unquote(args[j]).toLowerCase()
        if (a !== '-exec' && a !== '-execdir' && a !== '-ok' && a !== '-okdir') continue
        const payload = args.slice(j + 1).map(unquote).join(' ')
        if (payload.trim()) {
          const r = scanAll(payload, depth + 1)
          if (r) return r
        }
      }
    }
    if (cmd === 'ssh' || cmd === 'ssh.exe') {
      const hostIdx = skipFlags(args, 0, SSH_ARG_FLAGS)
      const payload = args.slice(hostIdx + 1).map(unquote).join(' ')
      if (payload.trim()) {
        const r = scanAll(payload, depth + 1)
        if (r) return r
      }
    }
    const hit = mentionHit(cmd, args)
    if (hit) return hit
  }
  return ''
}

/** 剥 PowerShell here-string 正文；不平衡返回 null（调用方按原文 fail-closed）。 */
function stripHereStrings (text) {
  const lines = String(text).split('\n')
  const out = []
  let end = ''
  for (const line of lines) {
    if (end) {
      if (line.trim() === end) { end = ''; out.push('') }
      continue
    }
    const t = line.trimEnd()
    if (t.endsWith("@'")) { end = "'@"; out.push(line.slice(0, -2)); continue }
    if (t.endsWith('@"')) { end = '"@'; out.push(line.slice(0, -2)); continue }
    out.push(line)
  }
  return end ? null : out.join('\n')
}

/** 剥 bash heredoc 正文；不平衡返回 null（调用方按原文 fail-closed）。 */
const HEREDOC_RE = /<<(-?)\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g
function stripHeredocs (text) {
  const lines = String(text).split('\n')
  const out = []
  const queue = []
  for (const line of lines) {
    if (queue.length) {
      const cur = queue[0]
      const cmp = cur.stripTabs ? line.replace(/^\t+/, '') : line
      if (cmp.trim() === cur.tag) { queue.shift(); out.push('') }
      continue
    }
    out.push(line)
    HEREDOC_RE.lastIndex = 0
    let m
    while ((m = HEREDOC_RE.exec(line))) queue.push({ stripTabs: m[1] === '-', tag: m[2] || m[3] || m[4] })
  }
  return queue.length ? null : out.join('\n')
}

/**
 * 预处理：剥 heredoc / here-string 正文。解析不平衡时返回 null。
 * 注意这里只剥「正文」，命令本身的引号内容保留（`sh -c "mkfs ..."` 还要靠递归扫描来发现）。
 */
function stripNoise (text) {
  const once = stripHereStrings(String(text))
  if (once === null) return null
  return stripHeredocs(once)
}

/** 解析不平衡时的「宽匹配」：状态不确定就宁可多拦，仍按老规则思路扫全文。 */
const BROAD_MENTION_RULES = [
  { label: '清空磁盘/分区', re: /\b(?:mkfs(?:\.\w+)?|mke2fs|fdisk|parted|diskpart|wipefs)\b/i },
  { label: '关闭/重启电脑', re: /\b(?:shutdown|Stop-Computer|Restart-Computer|reboot|halt|poweroff)\b/i },
  { label: '格式化磁盘', re: /\bformat\s+[a-zA-Z]:/i },
  { label: '改注册表关键项', re: /\breg\s+(?:add|delete)\s+(?:HKLM|HKEY_LOCAL_MACHINE)\b/i },
  { label: '删除卷影副本/引导配置', re: /\b(?:vssadmin\s+delete\s+shadows|bcdedit|wbadmin\s+delete)\b/i },
]

/** 规则全套扫描（供递归 payload 复用）。 */
function scanAll (text, depth = 0) {
  const stripped = stripNoise(text)
  if (stripped === null) {
    // heredoc / here-string / 引号状态不确定：按原文宽匹配，保持 fail-closed
    const raw = String(text)
    if (touchesAurabotModules(raw)) return AURABOT_MODULES_DANGER
    for (const rule of EXEC_RULES) if (rule.re.test(raw)) return rule.label
    for (const rule of BROAD_MENTION_RULES) if (rule.re.test(raw)) return rule.label
    return ''
  }
  if (touchesAurabotModules(stripped)) return AURABOT_MODULES_DANGER
  for (const rule of EXEC_RULES) {
    if (rule.re.test(stripped)) return rule.label
  }
  return scanMentions(stripped, depth)
}

/** 判断一条命令是否危险；返回命中的规则（含中文标签），不危险返回 null。 */
export function isDangerousCommand (command) {
  const text = String(command || '')
  if (!text.trim()) return null
  const label = scanAll(text)
  return label ? { label } : null
}

/**
 * 包一层「这个会话是不是 aurabot 自己开的」判断（工具 pre-execute 是进程级钩子）：
 * 判断不出来（isOwnedSession 缺失 / 抛错）时按 owned=true 处理，保留原有 fail-closed 路径；
 * 只有明确返回 false（宿主自己的 GUI/CLI 会话）才交给 DSH 自己的权限系统。
 * @param {null|((sessionId:string)=>boolean)} probe
 * @returns {(sessionId:string)=>boolean}
 */
export function safeOwnedSession (probe) {
  return (sessionId) => {
    if (typeof probe !== 'function') return true
    try { return probe(sessionId) !== false } catch (error) { return true }
  }
}

const clip = (text, n = 300) => (text.length > n ? text.slice(0, n) + '…' : text)

/**
 * 危险命令确认器。host 负责把 DSH 的 tools/pre-execute 和 QQ 私聊回复接进来。
 * @param {object} o
 * @param {() => object} o.getConfig 读最新配置（每次工具调用都重新判断开关）
 * @param {(chatId:string, text:string) => Promise<any>} o.deliver 发 QQ 消息（主人私聊）
 * @param {(sessionId:string) => string} o.chatOfSession DSH session → QQ chatId
 * @param {(sessionId:string) => boolean} [o.isOwnedSession] 这个会话是不是 aurabot 自己开的（QQ 聊天映射来的）
 * @param {() => string} o.ownerQQ 主人 QQ 号
 * @param {number} [o.timeoutMs] 等确认的超时（默认 60 秒）
 * @param {object} [o.log]
 */
export function createDangerGuard ({ getConfig, deliver, chatOfSession, isOwnedSession, ownerQQ, timeoutMs = 60_000, log } = {}) {
  const pending = new Map() // chatId → { resolve, timer }
  let disposed = false

  function cleanup (chatId, value) {
    const p = pending.get(chatId)
    if (!p) return false
    pending.delete(chatId)
    clearTimeout(p.timer)
    p.resolve(value)
    return true
  }

  /**
   * 工具执行前：命中危险规则就发 QQ 问主人，等回复；确认才放行。
   * next() 返回 allow；返回 deny 时 DSH 会把 reason 给模型。
   */
  async function preExecute (exec, next) {
    if (disposed) return { kind: 'deny', reason: '插件已卸载，取消旧工具调用。' }
    // DSH 的智能体团队是全局工具，打开后群聊会话也拿得到；成员有电脑权限，只有主人私聊能用
    if (String(exec?.name || '') === 'spawn_teammate') {
      const chatId = chatOfSession ? String(chatOfSession(exec.agent?.session?.id) || '') : ''
      if (chatId && chatId !== `private:${ownerQQ ? ownerQQ() : ''}`) {
        log?.warn?.(`已拦下 spawn_teammate（${chatId}）`)
        return { kind: 'deny', reason: '只有主人私聊才能创建成员。' }
      }
    }
    const cfg = getConfig() || {}
    if (!cfg.security || cfg.security.dangerConfirm !== true) return next()
    const tool = String(exec && exec.name || '')
    if (tool !== 'bash' && tool !== 'pwsh') return next()
    const command = String(exec.arguments && exec.arguments.command || '')
    const danger = isDangerousCommand(command)
    if (!danger) return next()
    const sessionId = exec.agent && exec.agent.session && exec.agent.session.id
    // 只管 aurabot 自己开的会话。tools/pre-execute 是进程级的，同一个 DSH 进程里主人自己开的
    // Web GUI / CLI 会话也会走到这里；那些命令不归这个守卫管，不该被 QQ 的安全策略拦下
    // （何况拦下时拿不到 chatId，连确认消息都发不出去，主人没有任何办法放行）。
    // 没传 isOwnedSession 的调用方（老用法 / 单测）保持原行为，照旧往下判断。
    if (typeof isOwnedSession === 'function') {
      let owned = null
      // 判断不出来（抛错）就按老逻辑走，仍然 fail-closed
      try { owned = !!isOwnedSession(sessionId) } catch (error) { owned = null }
      if (owned === false) return next()
    }
    const chatId = chatOfSession ? String(chatOfSession(sessionId) || '') : ''
    const owner = String(ownerQQ ? ownerQQ() : '')
    const ownerChat = owner ? `private:${owner}` : ''
    // 是我的会话但认不出聊天（比如 QQ 会话刚建立、映射还没落盘）：不敢放也不敢问，仍然拦下
    if (!chatId || chatId !== ownerChat) {
      log?.warn?.(`危险命令已拦下（非主人私聊 ${chatId || '未知'}）：${clip(command, 120)}`)
      return { kind: 'deny', reason: `这条命令被安全策略拦下了（${danger.label}）：只有主人私聊里、并且经过主人确认才能执行。` }
    }
    // 同一个人已经在等确认：别再发第二条，直接拦
    if (pending.has(chatId)) {
      return { kind: 'deny', reason: `上一条危险命令还在等主人确认（${danger.label}），这条先不执行。` }
    }
    const seconds = Math.max(1, Math.round(timeoutMs / 1000))
    const question = [
      `⚠️ 危险命令确认（${danger.label}）`,
      clip(command, 260),
      `回复「确认」执行，回复「取消」拦下；${seconds} 秒内没回也会拦下。`,
    ].join('\n')
    let ok = false
    try {
      const asked = new Promise((resolve) => {
        // 注意别 unref：系统就在等这个确认（工具调用被挂住），计时器必须撑着
        const timer = setTimeout(() => { cleanup(chatId, false); log?.warn?.(`危险命令确认超时，已拦下：${clip(command, 120)}`) }, timeoutMs)
        pending.set(chatId, { resolve, timer })
      })
      ;(async () => { try { await deliver(ownerChat, question) } catch (error) { log?.warn?.('危险命令确认消息没发出去：', error.message); cleanup(chatId, false) } })()
      ok = await asked
    } catch (error) {
      log?.warn?.('危险命令确认出错：', error.message)
      ok = false
    }
    if (ok && !disposed) {
      // 等待期间可能已经关闭确认开关或换了主人：旧确认不能继续放行
      const nowCfg = getConfig() || {}
      const ownerNow = String(ownerQQ ? ownerQQ() : '')
      if (nowCfg.security?.dangerConfirm !== true || ownerNow !== owner) {
        log?.warn?.(`危险命令确认已失效（开关或主人已变），拦下：${clip(command, 120)}`)
        return { kind: 'deny', reason: `危险命令确认已失效（${danger.label}）：确认开关或主人身份在执行前发生了变化，请重新发起。` }
      }
      log?.info?.(`主人确认执行危险命令（${danger.label}）：${clip(command, 120)}`)
      return next()
    }
    log?.info?.(`主人没确认危险命令（${danger.label}），已拦下：${clip(command, 120)}`)
    return { kind: 'deny', reason: `危险命令被主人拦下了（${danger.label}）：主人没有回复「确认」。要执行的话，请主人在私聊里回复「确认」后再试；也可以换个安全的做法。` }
  }

  /**
   * 处理主人 QQ 私聊回复。命中的确认/取消返回 true（这条消息被消费，不再交给她）；
   * 其它消息返回 false，照常走原来的聊天流程。
   */
  function handleReply (chatId, userId, text) {
    if (!pending.has(String(chatId || ''))) return false
    // 等待期间关闭确认开关：取消旧 pending，不再接受旧确认
    const cfg = getConfig() || {}
    if (!cfg.security || cfg.security.dangerConfirm !== true) {
      cleanup(String(chatId), false)
      return false
    }
    const owner = String(ownerQQ ? ownerQQ() : '')
    if (!isOwner({ ownerQQ: owner }, userId)) return false
    const t = String(text || '').trim()
    if (CONFIRM_RE.test(t)) return cleanup(String(chatId), true)
    if (CANCEL_RE.test(t)) return cleanup(String(chatId), false)
    return false
  }

  return {
    preExecute,
    handleReply,
    dispose() {
      disposed = true
      for (const chatId of pending.keys()) cleanup(chatId, false)
    },
    /** 等确认中的数量（测试/排查用） */
    get pendingCount () { return pending.size },
  }
}
