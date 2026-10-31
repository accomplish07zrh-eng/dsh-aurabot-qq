// Keep native tools, audience checks, routes and history reconciliation.
export default {
  id: 'diary', name: '空间日记', version: '1.1.0', api: 1, tab: 'diary',
  description: '沿用内置空间权限和发布链路，可选图文日记与预览。',
  setup(api) {
    const native = api.lib('modules/diary/index.js').default.setup(api)
    const base = Object.fromEntries(['post','writeDiary','tick','history','nextTime'].map(key => [key, native[key].bind(native)]))
    for (const key of Object.keys(base)) {
      native[key] = (...args) => {
        const rich = api.use('diary-rich')
        return typeof rich?.[key] === 'function' ? rich[key](...args) : base[key](...args)
      }
    }
    return { ...native, nativePost: base.post }
  },
}
