// 网关韧性：启动前探测/等待（A）+ 发送失败重试（B）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

const { endpointHostPort, portOpen, gatewayHealthy, waitPortFree } = await import('../src/snowluma/manager.js')
const { createOneBotClient, OneBotError } = await import('../src/onebot/client.js')

const silent = { info () {}, warn () {}, debug () {}, error () {} }

// ---------- A. 启动前探测 ----------

test('endpointHostPort：从 URL 拆 host/port，坏地址返回 null', () => {
  assert.deepEqual(endpointHostPort('http://127.0.0.1:3000'), { host: '127.0.0.1', port: 3000 })
  assert.deepEqual(endpointHostPort('http://localhost:3001/onebot'), { host: 'localhost', port: 3001 })
  assert.deepEqual(endpointHostPort('http://127.0.0.1'), { host: '127.0.0.1', port: 80 }, '没写端口按 80')
  assert.equal(endpointHostPort(''), null)
  assert.equal(endpointHostPort('乱写'), null)
})

test('portOpen：有监听 true，关了变 false', async () => {
  const server = net.createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  assert.equal(await portOpen({ host: '127.0.0.1', port }), true)
  await new Promise((r) => server.close(r))
  assert.equal(await portOpen({ host: '127.0.0.1', port }), false)
})

test('waitPortFree：端口释放后返回 true', async () => {
  const server = net.createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  setTimeout(() => server.close(), 300)
  const freed = await waitPortFree({ host: '127.0.0.1', port }, { timeoutMs: 3000, intervalMs: 100 })
  assert.equal(freed, true)
})

test('waitPortFree：一直占着就返回 false（不会无限等）', async () => {
  const server = net.createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const t = Date.now()
  const freed = await waitPortFree({ host: '127.0.0.1', port }, { timeoutMs: 600, intervalMs: 100 })
  assert.equal(freed, false)
  assert.ok(Date.now() - t < 3000, '应该按时放弃')
  await new Promise((r) => server.close(r))
})

test('gatewayHealthy：真正的 OneBot 应答才算活着', async () => {
  const ep = { httpUrl: 'http://127.0.0.1:3000', httpToken: 'T' }
  const ok = async () => new Response(JSON.stringify({ status: 'ok', data: { user_id: 1 } }), { status: 200 })
  const retOk = async () => new Response(JSON.stringify({ retcode: 0, data: {} }), { status: 200 })
  const bad = async () => new Response(JSON.stringify({ status: 'failed', retcode: 1404 }), { status: 200 })
  const boom = async () => { throw new Error('fetch failed') }
  assert.equal(await gatewayHealthy(ep, { fetchImpl: ok }), true)
  assert.equal(await gatewayHealthy(ep, { fetchImpl: retOk }), true)
  assert.equal(await gatewayHealthy(ep, { fetchImpl: bad }), false, 'retcode 不通不算活着')
  assert.equal(await gatewayHealthy(ep, { fetchImpl: boom }), false)
  assert.equal(await gatewayHealthy({ httpUrl: '' }, { fetchImpl: ok }), false, '没配地址直接 false')

  // 带 token 时会加 Authorization 头
  let seen = null
  await gatewayHealthy(ep, { fetchImpl: async (url, init) => { seen = init.headers; return new Response('{"status":"ok"}', { status: 200 }) } })
  assert.equal(seen.authorization, 'Bearer T')
})

// ---------- B. 发送层重试 ----------

function client(fetchImpl, opts = {}) {
  const calls = []
  const orig = globalThis.fetch
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init) }
  const c = createOneBotClient({
    endpoint: () => ({ httpUrl: 'http://127.0.0.1:3000', httpToken: '', wsUrl: '', wsToken: '' }),
    onEvent: () => {},
    onState: () => {},
    log: silent,
    retryDelays: [10, 10],
    ...opts,
  })
  return { c, calls, restore: () => { globalThis.fetch = orig } }
}

test('网络层失败会重试，成功后正常返回', async () => {
  let n = 0
  const h = client(async () => {
    n++
    if (n < 3) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    return new Response(JSON.stringify({ status: 'ok', data: { message_id: 7 } }), { status: 200 })
  })
  try {
    const data = await h.c.call('send_private_msg', { user_id: 1, message: 'hi' })
    assert.equal(data.message_id, 7)
    assert.equal(h.calls.length, 3, '失败两次后第三次成功')
  } finally { h.restore() }
})

test('重试用完还失败：报错里写清楚连不上网关（不像原来只说 fetch failed）', async () => {
  const h = client(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) })
  try {
    await assert.rejects(() => h.c.call('send_private_msg', {}), (err) => {
      assert.ok(err instanceof OneBotError)
      assert.match(err.message, /连不上 QQ 网关/)
      assert.match(err.message, /ECONNREFUSED/)
      assert.equal(h.calls.length, 3, '一共试 3 次（初始 + 2 次重试）')
      return true
    })
  } finally { h.restore() }
})

test('stop 立即结束所有重试等待，重启后旧请求也不能继续', async () => {
  let waits = 0, ready
  const waiting = new Promise((resolve) => { ready = resolve })
  const h = client(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }, {
    retryDelays: [10_000],
    log: { ...silent, warn() { if (++waits === 2) ready() } },
  })
  try {
    const first = h.c.call('send_private_msg', {}).catch((error) => error)
    const second = h.c.call('send_group_msg', {}).catch((error) => error)
    await waiting
    h.c.stop()
    await assert.rejects(() => h.c.call('after_stop', {}), /已停止/)
    assert.equal(h.calls.length, 2)
    h.c.start()
    let timer
    const result = await Promise.race([
      Promise.all([first, second]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('重试等待没有立即结束')), 500) }),
    ]).finally(() => clearTimeout(timer))
    assert.ok(result.every((error) => error instanceof OneBotError && /已停止/.test(error.message)))
    assert.equal(h.calls.length, 2)
  } finally { h.c.stop(); h.restore() }
})

test('重试日志触发 stop 时不会留下新的等待', async () => {
  let h
  h = client(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }, {
    retryDelays: [10_000], log: { ...silent, warn() { h.c.stop() } },
  })
  try {
    const error = await h.c.call('send_private_msg', {}).catch((error) => error)
    assert.match(error.message, /已停止/)
    assert.equal(h.calls.length, 1)
  } finally { h.c.stop(); h.restore() }
})

test('请求在途时 stop，连接失败后不再重试', async () => {
  let enter, release
  const entered = new Promise((resolve) => { enter = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const h = client(async () => {
    enter()
    await gate
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
  })
  try {
    const work = h.c.call('send_private_msg', {}).catch((error) => error)
    await entered
    h.c.stop()
    release()
    const error = await work
    assert.match(error.message, /已停止/)
    assert.equal(h.calls.length, 1)
  } finally { release(); h.c.stop(); h.restore() }
})

test('业务错误不重试（retcode 不为 0 直接抛）', async () => {
  const h = client(async () => new Response(JSON.stringify({ status: 'failed', retcode: 1404, message: '没权限' }), { status: 200 }))
  try {
    await assert.rejects(() => h.c.call('send_private_msg', {}), /没权限/)
    assert.equal(h.calls.length, 1, '业务错误只调一次')
  } finally { h.restore() }
})

test('超时不重试（可能已经发出去了，重试会重复）', async () => {
  const h = client(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) })
  try {
    await assert.rejects(() => h.c.call('send_private_msg', {}), /超时/)
    assert.equal(h.calls.length, 1, '超时只调一次')
  } finally { h.restore() }
})

test('读取 HTTP 回执时超时仍然报告超时，不按业务失败处理', async () => {
  const h = client(async () => ({ status: 200, json: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) } }))
  try {
    await assert.rejects(() => h.c.call('send_private_msg', {}), (err) => {
      assert.equal(err.uncertain, true)
      assert.match(err.message, /超时/)
      return true
    })
    assert.equal(h.calls.length, 1)
  } finally { h.restore() }
})

test('连接建立后断开或回执无法解析：结果不确定，不自动重试', async () => {
  for (const fetchImpl of [
    async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) },
    async () => new Response('不是 JSON', { status: 200 }),
  ]) {
    const h = client(fetchImpl)
    try {
      await assert.rejects(() => h.c.call('send_private_msg', {}), (err) => {
        assert.equal(err.uncertain, true)
        assert.equal(err.transport, false)
        return true
      })
      assert.equal(h.calls.length, 1)
    } finally { h.restore() }
  }
})
