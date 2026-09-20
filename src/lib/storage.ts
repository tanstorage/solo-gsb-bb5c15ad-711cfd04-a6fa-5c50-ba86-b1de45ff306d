import type { AppState, Priority } from '../types'

const STORAGE_KEY = 'temporal-constraint-checker:v1'

/** 规范化层级表：丢弃非法层级（非法/缺失时由排程层按默认「中」处理） */
function normalizePriorities(raw: unknown): Record<string, Priority> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, Priority> = {}
  for (const [id, p] of Object.entries(raw as Record<string, unknown>)) {
    if (p === 'high' || p === 'medium' || p === 'low') out[id] = p
  }
  return out
}

export function loadState(): AppState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as AppState
    if (!Array.isArray(parsed.events) || !Array.isArray(parsed.constraints)) return null
    // 旧版本存档没有期望时刻字段：规范化为空表
    if (!parsed.desiredTimes || typeof parsed.desiredTimes !== 'object') {
      parsed.desiredTimes = {}
    }
    // 旧版本存档没有分层优先级字段：规范化为空表（读取时按默认「中」处理）
    parsed.desiredPriorities = normalizePriorities((parsed as Partial<AppState>).desiredPriorities)
    return parsed
  } catch {
    return null
  }
}

export function saveState(state: AppState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 隐私模式 / 配额不足时静默失败，不影响使用
  }
}

export function clearState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}
