import type {
  Constraint,
  Priority,
  ScheduleEntry,
  ScheduleLayerResult,
  ScheduleResult,
  TEvent,
} from '../types'
import { PRIORITY_LEVELS } from '../types'
import { analyze, buildEdges, feasiblePotentials } from './graph'

const MINUTE_MS = 60_000

/** 钉住期望事件时使用的合成约束 id（仅内部标识，不进入展示） */
const PIN_ID = '__desired_pin__'

/** 未指定层级时的默认优先级：兼容旧数据（旧存档无 desiredPriorities 字段） */
export const DEFAULT_PRIORITY: Priority = 'medium'

/** 解析期望时刻为相对锚点的分钟偏移；无效输入返回 null */
function desiredOffsetMin(anchorISO: string, desiredISO: string): number | null {
  const a = new Date(anchorISO).getTime()
  const t = new Date(desiredISO).getTime()
  if (Number.isNaN(a) || Number.isNaN(t)) return null
  return Math.round((t - a) / MINUTE_MS)
}

/**
 * 分层最小偏差排程（高 → 中 → 低 字典序最小化）。
 *
 * 前提：约束系统可满足且已设置锚点（不满足时返回 null）。
 * 对每个「已填写有效期望时刻且与锚点连通」的非锚点事件 i，记其期望相对锚点偏移为
 * d_i、所属层级为 p_i ∈ {高, 中, 低}。对每个层级 L 定义
 *
 *     D_L = max_{i: p_i = L} |t_i − d_i|
 *
 * （无该层事件时 D_L 不参与向量）。我们在**同一个整体差分系统**上按字典序最小化
 * (D_高, D_中, D_低)：
 *
 * 1. 先求使全部启用约束与高优先级钉住约束
 *    `d_i − D_高 ≤ t_i − t_anchor ≤ d_i + D_高` 同时可满足的最小非负整数 D_高；
 * 2. 固定高优先级容差 D_高（高优先级事件永久钉住在其最优容差内），再对中优先级
 *    求最小 D_中；
 * 3. 固定 (D_高, D_中) 后，对低优先级求最小 D_低。
 *
 * 三层使用的是**同一个差分图**（原边 + 已固定层的钉住边 + 当前候选层的钉住边），
 * 因此：
 * - 不是加权和（层级间不存在权重折衷，高优先级 D 永远优先取最小）；
 * - 也不是分别排程后拼接（每层求解都带上全部原约束与更高层钉住边做整体负环检测，
 *   事件间耦合被完整保留）。
 *
 * 每层候选容差的可行性都通过对**整体**差分图做负环检测来判定，而不是把各事件
 * 独立夹到各自的时间窗——后者忽略事件间耦合（例如 t_Y = t_X + 5 时，X、Y 各自的
 * 窗口都可能包含期望值，但二者不能同时取到），会得出偏小的伪最优。
 *
 * 单层最小容差搜索结构：
 * 1. 上界：当前已钉住图上的任一可行势 t*（超级源点 Bellman-Ford）给出可行上界
 *    max_{i ∈ 本层} |t*_i − d_i|；
 * 2. 在 [0, 上界] 上二分最小的可行非负整数；
 * 3. 上一层固定的钉住边始终保留。
 *
 * 输出：三层全部钉住（容差取各层最优值）后的一组可行势（锚点平移到 0）。
 * 边集与边顺序确定时 Bellman-Ford 结果确定，因此输出是确定性的可行排程；
 * 每层的最小容差在其求解时达到（D−1 不可行），而后续层只会追加钉住边、
 * 不放松任何约束，故输出排程中每个非空层都必然有事件达到该层 ±D_L。
 *
 * 与锚点不连通的事件不参与搜索，在结果中标记为 unscheduled（未定时）；
 * 其上填写的期望时刻被忽略（desiredIgnored = true）。
 */
export function computeMinDeviationSchedule(
  events: TEvent[],
  constraints: Constraint[],
  anchorId: string | null,
  anchorTime: string,
  desiredTimes: Record<string, string>,
  desiredPriorities: Record<string, Priority> = {},
): ScheduleResult | null {
  const n = events.length
  const anchorIdx = anchorId != null ? events.findIndex((e) => e.id === anchorId) : -1
  if (n === 0 || anchorIdx < 0) return null

  const base = analyze(events, constraints, anchorId)
  if (!base.satisfiable) return null

  const { edges } = buildEdges(events, constraints)
  const idxOf = new Map(events.map((e, i) => [e.id, i]))

  // 期望时刻 → 相对锚点的分钟偏移（锚点自身时间固定，其期望无意义，直接排除）
  const desired = new Map<number, number>()
  const priorityOf = new Map<number, Priority>()
  for (const [id, iso] of Object.entries(desiredTimes)) {
    const i = idxOf.get(id)
    if (i === undefined || i === anchorIdx || !iso) continue
    const off = desiredOffsetMin(anchorTime, iso)
    if (off === null) continue
    desired.set(i, off)
    // 旧数据 / 未选择层级时按「中」处理
    const p = desiredPriorities[id]
    priorityOf.set(i, p === 'high' || p === 'medium' || p === 'low' ? p : DEFAULT_PRIORITY)
  }

  const connected = (i: number) => {
    const w = base.windows.get(i)
    return !!w && w.status !== 'disconnected'
  }

  // 分层收集参与整体搜索的期望事件（层内按事件下标升序，保证确定性）
  const targetsByLevel = new Map<Priority, number[]>()
  for (const level of PRIORITY_LEVELS) targetsByLevel.set(level, [])
  for (const i of [...desired.keys()].filter(connected).sort((a, b) => a - b)) {
    targetsByLevel.get(priorityOf.get(i) ?? DEFAULT_PRIORITY)!.push(i)
  }
  const totalTargets = [...targetsByLevel.values()].reduce((s, arr) => s + arr.length, 0)
  if (totalTargets === 0) return null

  /**
   * 在已固定层钉住边 fixed 之外，为 targets 中的事件追加容差 tol 的钉住边。
   * 钉住边：anchor → i 权 d+tol（t_i − t_anchor ≤ d+tol），
   *         i → anchor 权 tol−d（t_anchor − t_i ≤ tol−d）。
   */
  const appendPins = (base2: typeof edges, targets: number[], tol: number) => {
    const es = base2.slice()
    for (const i of targets) {
      const d = desired.get(i)!
      es.push(
        { u: anchorIdx, v: i, w: d + tol, constraintId: PIN_ID, bound: 'upper' as const },
        { u: i, v: anchorIdx, w: tol - d, constraintId: PIN_ID, bound: 'lower' as const },
      )
    }
    return es
  }

  // —— 分层字典序最小化：依次固定高 → 中 → 低 的最优容差 ——
  const DByLevel = new Map<Priority, number>()
  let fixedEdges = edges.slice() // 已固定的更高层钉住边（始终保留）
  for (const level of PRIORITY_LEVELS) {
    const targets = targetsByLevel.get(level)!
    if (targets.length === 0) continue

    // 上界：当前已钉住图上的可行势 t* 给出本层必然可行的容差
    const pot = feasiblePotentials(n, fixedEdges)
    if (!pot) return null // 防御：更高层固定时已验证可行，理论不可达
    let hi = 0
    for (const i of targets) {
      hi = Math.max(hi, Math.abs(pot[i] - pot[anchorIdx] - desired.get(i)!))
    }

    // 二分最小可行非负整数；不变式：lo 不可行（−1 为哨兵），hi 可行
    let lo = -1
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if (feasiblePotentials(n, appendPins(fixedEdges, targets, mid)) !== null) hi = mid
      else lo = mid
    }
    DByLevel.set(level, hi)
    // 本层容差固定：钉住边并入 fixedEdges，供更低层在同一整体系统上求解
    fixedEdges = appendPins(fixedEdges, targets, hi)
  }

  // 输出排程：全部层钉住后的可行势，锚点平移到 0（确定性）
  const h = feasiblePotentials(n, fixedEdges)!
  const offsetOf = (i: number) => h[i] - h[anchorIdx]

  const entries: ScheduleEntry[] = events.map((_, i): ScheduleEntry => {
    const d = desired.get(i) ?? null
    const prio = d !== null ? priorityOf.get(i) ?? DEFAULT_PRIORITY : null
    if (i === anchorIdx) {
      return {
        eventIdx: i,
        status: 'anchor',
        offsetMin: 0,
        desiredOffset: null,
        deviation: null,
        priority: null,
        desiredIgnored: false,
      }
    }
    if (!connected(i)) {
      return {
        eventIdx: i,
        status: 'unscheduled',
        offsetMin: null,
        desiredOffset: d,
        deviation: null,
        priority: prio,
        desiredIgnored: d !== null,
      }
    }
    const off = offsetOf(i)
    return {
      eventIdx: i,
      status: 'scheduled',
      offsetMin: off,
      desiredOffset: d,
      deviation: d !== null ? off - d : null,
      priority: prio,
      desiredIgnored: false,
    }
  })

  // 各层结果：本层最优 D 与输出排程中达到该层 ±D 的事件
  const layers = PRIORITY_LEVELS.map((level): ScheduleLayerResult => {
    const targets = targetsByLevel.get(level)!
    const D = DByLevel.has(level) ? DByLevel.get(level)! : null
    const tightEventIdx: number[] = []
    if (D !== null) {
      for (const i of targets) {
        if (Math.abs(entries[i].deviation!) === D) tightEventIdx.push(i)
      }
    }
    return { level, D, count: targets.length, tightEventIdx }
  }) as ScheduleResult['layers']

  let maxDeviation = 0
  for (const layer of layers) {
    if (layer.D !== null && layer.D > maxDeviation) maxDeviation = layer.D
  }

  return { entries, layers, maxDeviation, desiredCount: totalTargets }
}
