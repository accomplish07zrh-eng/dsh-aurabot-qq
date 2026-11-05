// SSRF 防护的两种强度：严格（默认）/ 宽松。宽松只放行「公网 + 内网混合返回」的域名。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { ssrfBlocked, setSsrpMode, currentSsrpMode, assertPublicUrl, isPrivateIp, fetchImage } = await import('../src/core/net.js')
const { normalize } = await import('../src/core/config.js')

// 本机代理 DNS 的真实形态：公网 A + IPv6 ULA
const MIXED = ['28.0.0.162', 'fdfe:dcba:9876::96']
const PUBLIC_ONLY = ['28.0.0.162']
const PRIVATE_ONLY = ['192.168.1.10']
const LOOPBACK = ['127.0.0.1']
const METADATA = ['169.254.169.254']

test('配置：SSRF 模式默认 strict，只接受 strict / loose', () => {
  assert.equal(normalize({}).security.ssrfMode, 'strict')
  assert.equal(normalize({ security: { ssrfMode: 'loose' } }).security.ssrfMode, 'loose')
  assert.equal(normalize({ security: { ssrfMode: '随便写' } }).security.ssrfMode, 'strict')
  assert.equal(normalize({ security: null }).security.ssrfMode, 'strict')
})

test('严格模式：只要有一个内网地址就拒绝', () => {
  assert.equal(ssrfBlocked(MIXED, 'strict'), true, '公网 + ULA → 拒绝')
  assert.equal(ssrfBlocked(PUBLIC_ONLY, 'strict'), false)
  assert.equal(ssrfBlocked(PRIVATE_ONLY, 'strict'), true)
  assert.equal(ssrfBlocked(LOOPBACK, 'strict'), true)
  assert.equal(ssrfBlocked(METADATA, 'strict'), true)
  assert.equal(ssrfBlocked([], 'strict'), true, '解析不出来也拒绝')
})

test('宽松模式：全部是内网才拒绝', () => {
  assert.equal(ssrfBlocked(MIXED, 'loose'), false, '公网 + ULA → 放行（这是它存在的理由）')
  assert.equal(ssrfBlocked(PUBLIC_ONLY, 'loose'), false)
  assert.equal(ssrfBlocked(PRIVATE_ONLY, 'loose'), true)
  assert.equal(ssrfBlocked(LOOPBACK, 'loose'), true)
  assert.equal(ssrfBlocked([], 'loose'), true)
  // 关键：纯内网目标在宽松模式下依然拦得住
  assert.equal(ssrfBlocked(['10.0.0.5'], 'loose'), true)
  assert.equal(ssrfBlocked(['::1'], 'loose'), true)
})

test('注入的模式会生效（面板切换后不用重启）', () => {
  assert.equal(currentSsrpMode(), 'strict', '默认严格')
  assert.equal(ssrfBlocked(MIXED), true)

  setSsrpMode(() => 'loose')
  assert.equal(currentSsrpMode(), 'loose')
  assert.equal(ssrfBlocked(MIXED), false, '切成宽松后，同一个混合结果放行')

  setSsrpMode(() => 'strict')
  assert.equal(currentSsrpMode(), 'strict')
  assert.equal(ssrfBlocked(MIXED), true, '切回严格又拦住')

  setSsrpMode(() => '乱写的值')
  assert.equal(currentSsrpMode(), 'strict', '非 loose 一律当严格')
  setSsrpMode(null)
})

test('两种模式下，字面内网地址都还是拒绝', async () => {
  for (const mode of ['strict', 'loose']) {
    setSsrpMode(() => mode)
    for (const url of ['http://127.0.0.1/x', 'http://192.168.1.10/x', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/x', 'http://localhost/x', 'file:///etc/passwd']) {
      await assert.rejects(() => assertPublicUrl(url), `${mode} 模式下 ${url} 应该被拦`)
    }
  }
  setSsrpMode(null)
})

test('IPv6 变形地址（IPv4-mapped / NAT64 / 6to4 / 文档段）也拦得住', async () => {
  setSsrpMode(() => 'strict')
  for (const url of [
    'http://[::ffff:192.168.1.1]/x', // URL 正规化成 ::ffff:c0a8:101
    'http://[::ffff:172.16.0.1]/x',
    'http://[::ffff:169.254.169.254]/x',
    'http://[::ffff:ac10:1]/x', // 172.16.0.1 的十六进制写法
    'http://[64:ff9b::172.16.0.1]/x',
    'http://[2002:7f00:1::]/x',
    'http://[2001:db8::1]/x',
    'http://[ff02::1]/x',
  ]) {
    await assert.rejects(() => assertPublicUrl(url), `应该拦下 ${url}`)
  }
  // 公网 IPv6 照常放行（字面地址不走 DNS）
  await assert.doesNotReject(() => assertPublicUrl('http://[2606:4700:4700::1111]/x'))
  setSsrpMode(null)
})

test('IPv4 保留段补全：0/8、100.64/10、文档段、保留段都算内网', () => {
  for (const ip of ['0.1.2.3', '100.64.0.1', '100.127.255.255', '192.0.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '240.0.0.1', '255.255.255.255']) {
    assert.equal(isPrivateIp(ip), true, ip)
  }
  for (const ip of ['8.8.8.8', '28.0.1.35', '2606:4700:4700::1111']) {
    assert.equal(isPrivateIp(ip), false, ip)
  }
})

test('代理 fake-ip：198.18.0.0/15 和 2001:2::/48 不能被当内网', () => {
  // Clash TUN / fake-ip 常把域名解析到这两段；拦了会让 QQ 图片/表情全挂
  for (const ip of ['198.18.0.40', '198.18.0.41', '198.18.0.108', '198.19.255.255', '2001:2::1']) {
    assert.equal(isPrivateIp(ip), false, ip)
  }
  // 真正的私网仍然拦
  for (const ip of ['192.168.1.10', '10.0.0.5', '127.0.0.1', '169.254.169.254', '::1', 'fc00::1']) {
    assert.equal(isPrivateIp(ip), true, ip)
  }
})

test('重定向到内网地址时，每一跳都会重新检查', async () => {
  setSsrpMode(() => 'strict')
  const calls = []
  const fake = async (url) => {
    calls.push(String(url))
    return new Response(null, { status: 302, headers: { location: 'http://[::ffff:172.16.0.1]/x' } })
  }
  await assert.rejects(
    () => fetchImage('https://[2606:4700:4700::1111]/a', { fetchImpl: fake }),
    /内网|本机/,
  )
  assert.deepEqual(calls, ['https://[2606:4700:4700::1111]/a'], '第二跳不应该真的发出去')
  setSsrpMode(null)
})
