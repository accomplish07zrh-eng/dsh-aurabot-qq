// 测试通过真实存储边界读写状态，不再假定运行后的记忆一定落在 memories.json。
import { createMemoryStorage } from '../../src/features/memory-store.js'

const log = { warn() {} }
export function readMemoryState(directory) {
  const store = createMemoryStorage({ directory, log })
  try { return store.load() } finally { store.close() }
}
export function writeMemoryState(directory, state) {
  const store = createMemoryStorage({ directory, log })
  try { store.load(); store.save(state) } finally { store.close() }
}
