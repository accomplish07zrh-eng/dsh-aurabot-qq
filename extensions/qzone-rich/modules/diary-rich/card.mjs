import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export function createCardRenderer(api) {
  const children = new Set(); let stopped = false
  return {
    async render(text, at) {
      if (stopped) throw new Error('手记卡已取消')
      const file = api.dataDir('card-' + randomUUID() + '.png')
      try {
        await new Promise((resolve, reject) => {
          const command = '[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;& ([scriptblock]::Create([IO.File]::ReadAllText($env:AURABOT_DIARY_CARD_SCRIPT,[Text.Encoding]::UTF8)))'
          const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, env: { ...process.env, AURABOT_DIARY_CARD_SCRIPT: join(api.dir, 'card.ps1') }, stdio: ['pipe', 'ignore', 'pipe'] })
          children.add(child); let tail = '', done = false
          const finish = (error) => { if (done) return; done = true; clearTimeout(timer); children.delete(child); error ? reject(error) : resolve() }
          const timer = setTimeout(() => { child.kill(); finish(new Error('手记卡生成超时')) }, 15000)
          child.on('error', (e) => finish(e)); child.stderr.on('data', (b) => { tail = (tail + b).slice(-400) }); child.stdin.on('error', () => {})
          child.on('close', (code) => finish(code === 0 && !stopped ? null : new Error('手记卡未生成：' + tail)))
          child.stdin.end(JSON.stringify({ file, text, date: new Date(at).toLocaleDateString('zh-CN'), theme: new Date(at).getDate() % 3 }))
        })
        return readFileSync(file)
      } finally { rmSync(file, { force: true }) }
    },
    dispose() { stopped = true; for (const child of children) child.kill() },
  }
}
