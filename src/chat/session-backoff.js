// 调度器只判断这个标识；退避状态和梯度统一由 hub 管理。
export const SESSION_BACKOFF = 'AURABOT_SESSION_BACKOFF'
export const isSessionBackoff = (error) => error?.code === SESSION_BACKOFF
