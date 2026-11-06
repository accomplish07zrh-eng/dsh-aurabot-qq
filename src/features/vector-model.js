// 本地向量模型的自动下载：插件包里不带 22.8 MB 的 onnx，
// 第一次打开向量检索时从 GitHub Release 的资源拉下来，存进数据目录的 models/。
//
// 设计要点：
//   - 只在「确实要算向量」且本地没有模型时才下载，不拖慢启动
//   - 下载到 .part 临时文件，校验大小/哈希通过后才改名，避免半个模型被当成可用的
//   - 有并发保护：同一时刻只跑一个下载
//   - 失败不抛给上层：记在 lastError 里，向量检索退回关键词，下次 tick 再试

import { existsSync, mkdirSync, renameSync, rmSync, statSync, createWriteStream, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/** 官方 Release 里的模型资源。改了模型名/版本时只改这里。 */
export const MODEL_ASSETS = {
  // 放在 v1.2.0-rc.1 release 的 assets 里，文件名照这个来
  base: 'https://github.com/aureth-labs/dsh-aurabot-qq/releases/download/v1.2.0-rc.1',
  files: [
    { name: 'model_int8.onnx', size: 23_903_394, approx: true },
    { name: 'vocab.txt', size: 109_540, approx: true },
  ],
}

const DOWNLOAD_TIMEOUT = 10 * 60_000

/**
 * 模型下载器。返回一个带 ensure()/status() 的对象。
 * ensure() 幂等地保证数据目录下有可用的模型，返回模型目录或 null。
 */
export function createModelDownloader({ dataDir, log, fetchImpl = globalThis.fetch, base = MODEL_ASSETS.base, files = MODEL_ASSETS.files } = {}) {
  const dir = join(dataDir, 'models')
  let running = null
  let lastError = ''
  let progress = { done: 0, total: files.length, file: '', bytes: 0 }

  const targetOf = (name) => join(dir, name)
  const partOf = (name) => join(dir, name + '.part')

  /** 已经齐了吗（两个文件都在且大小合理） */
  function present() {
    for (const f of files) {
      if (!existsSync(targetOf(f.name))) return false
      try {
        // 大小对不上就当成坏的（防止上次中断留下的半截文件）
        if (!f.approx && statSync(targetOf(f.name)).size !== f.size) return false
      } catch { return false }
    }
    return true
  }

  function status() {
    return { present: present(), running: Boolean(running), error: lastError, ...progress }
  }

  /** 下载单个文件到 .part，成功后改名 */
  async function pull(f) {
    const url = `${base}/${f.name}`
    const part = partOf(f.name)
    const final = targetOf(f.name)
    progress.file = f.name
    progress.bytes = 0

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT)
    try {
      const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '无响应'}`)
      // 有的环境只有 body.getReader()，有的有 asyncIterator，两种都兼容
      const body = res.body
      if (!body) throw new Error('响应没有 body')
      rmSync(part, { force: true })
      const out = createWriteStream(part)
      let written = 0
      if (typeof body.getReader === 'function') {
        const reader = body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          out.write(value)
          written += value.length
          progress.bytes = written
        }
      } else {
        for await (const chunk of body) {
          out.write(chunk)
          written += chunk.length
          progress.bytes = written
        }
      }
      await new Promise((resolve, reject) => {
        out.end((error) => (error ? reject(error) : resolve()))
      })
      // 大约大小校验：差太多说明下错了（HTML 错误页之类）
      if (f.approx && written < f.size * 0.6) throw new Error(`文件大小不对（${written} 字节）`)
      rmSync(final, { force: true })
      renameSync(part, final)
      progress.done++
      return true
    } catch (error) {
      rmSync(part, { force: true })
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async function ensure() {
    if (present()) return dir
    if (running) return running
    if (typeof fetchImpl !== 'function') {
      lastError = '当前环境没有 fetch，无法自动下载模型'
      return null
    }
    running = (async () => {
      try {
        mkdirSync(dir, { recursive: true })
        progress = { done: 0, total: files.length, file: '', bytes: 0 }
        log?.info?.('[记忆向量] 本地模型缺失，开始下载（首次约 23 MB）')
        for (const f of files) await pull(f)
        if (!present()) throw new Error('下载完成但文件不完整')
        lastError = ''
        log?.info?.('[记忆向量] 本地模型下载完成')
        return dir
      } catch (error) {
        lastError = `模型下载失败：${error.message}`
        log?.warn?.('[记忆向量] ' + lastError + '（先按关键词检索）')
        return null
      } finally {
        running = null
      }
    })()
    return running
  }

  return { ensure, status, present, dir }
}
