/**
 * 应用领域类型
 */

/** 事件（时间轴上的一个待定位的点） */
export interface TEvent {
  id: string
  name: string
  note?: string
}

/** 关系方向：A 早于 B，或 A 晚于 B */
export type Relation = 'earlier' | 'later'

/** 期望时刻的分层优先级；排程按 高 → 中 → 低 做字典序最小化 */
export type Priority = 'high' | 'medium' | 'low'

/** 层级顺序（字典序最小化的求解与展示顺序：高 → 中 → 低） */
export const PRIORITY_LEVELS = ['high', 'medium', 'low'] as const

export const PRIORITY_LABEL: Record<Priority, string> = {
  high: '高',
  medium: '中',
  low: '低',
}

/**
 * 一条“事件 A 比事件 B {早|晚} min..max 分钟”的约束。
 * min <= max，单位为分钟（整数）。
 */
export interface Constraint {
  id: string
  aId: string
  bId: string
  relation: Relation
  min: number
  max: number
  enabled: boolean
}

/** 应用持久化状态 */
export interface AppState {
  events: TEvent[]
  constraints: Constraint[]
  /** 锚点事件 id */
  anchorId: string | null
  /** 锚点绝对时间（本地时间，ISO 格式 yyyy-MM-ddTHH:mm） */
  anchorTime: string
  /** 各事件的期望时刻（事件 id -> 本地时间 ISO）；仅非锚点且与锚点连通的事件参与最小偏差排程 */
  desiredTimes: Record<string, string>
  /** 各事件期望时刻的分层优先级（事件 id -> 高/中/低）；未填写时按「中」处理；随状态持久化 */
  desiredPriorities: Record<string, Priority>
}

/** 差分图中的一条有向边 u -> v，权重 w（分钟），表示 t_v - t_u <= w */
export interface DiffEdge {
  u: number
  v: number
  w: number
  /** 产生该边的约束 id */
  constraintId: string
  /** 该边是约束的上界侧还是下界侧 */
  bound: 'upper' | 'lower'
}

export interface AnalysisResult {
  /** 是否存在矛盾（负环） */
  satisfiable: boolean
  /** 命中的一条矛盾环（按沿环行走的顺序） */
  cycle?: CycleInfo
  /** 每个事件的时间窗（仅可满足时计算） */
  windows: Map<number, WindowInfo>
}

export interface CycleInfo {
  /** 环上的节点，按环顺序，首尾不重复 */
  nodes: number[]
  /** 环上的边，edges[i] 从 nodes[i] 指向 nodes[(i+1) % n] */
  edges: DiffEdge[]
  /** 环上权重之和（严格小于 0） */
  totalWeight: number
}

export type WindowStatus = 'anchor' | 'bounded' | 'oneSided' | 'disconnected'

export interface WindowInfo {
  status: WindowStatus
  /** 相对锚点最早偏移（分钟）；单边/不可达时可能为 null（-∞） */
  earliestOffset: number | null
  /** 相对锚点最晚偏移（分钟）；单边/不可达时可能为 null（+∞） */
  latestOffset: number | null
}

/**
 * 边界追溯中的一步：沿一条差分边把边界从 from 事件推进到 to 事件。
 * edge 始终为原始图方向的差分边（u -> v，权 w 表示 t_v - t_u <= w）；
 * 最早边界在反向图上推导，此时行走方向 from -> to 与 edge.u -> edge.v 相反。
 */
export interface BoundTraceStep {
  /** 本步采用的原始差分边（含约束 id 与上/下界侧） */
  edge: DiffEdge
  /** 推导方向上的起点事件下标（从锚点出发） */
  from: number
  /** 推导方向上的终点事件下标 */
  to: number
  /** 走完该步后，to 事件相对锚点的累计偏移（分钟） */
  cumulative: number
}

/**
 * 某事件最早/最晚边界的推导链：从锚点出发的紧约束链。
 * steps 按推导顺序排列；锚点自身为零步证明（steps 为空）。
 */
export interface BoundTrace {
  /** 目标事件下标 */
  eventIdx: number
  /** 追溯的是最早边界还是最晚边界 */
  kind: 'earliest' | 'latest'
  /** 推导出的边界值：相对锚点的偏移（分钟） */
  offset: number
  /** 从锚点出发按推导顺序排列的步骤 */
  steps: BoundTraceStep[]
}

/** 最小偏差排程中单个事件的结果 */
export interface ScheduleEntry {
  eventIdx: number
  status: 'anchor' | 'scheduled' | 'unscheduled'
  /** 实际排程时刻相对锚点的偏移（分钟）；未定时为 null */
  offsetMin: number | null
  /** 期望时刻相对锚点的偏移（分钟）；未填写或无效为 null */
  desiredOffset: number | null
  /** 实际 − 期望（分钟）；仅对已填写期望且已定时的事件 */
  deviation: number | null
  /** 该事件期望所属的优先级层（已填写有效期望时给出；未填写期望或锚点为 null） */
  priority: Priority | null
  /** 期望因事件未与锚点连通而被忽略 */
  desiredIgnored: boolean
}

/** 单个优先级层的字典序最优结果 */
export interface ScheduleLayerResult {
  /** 层级（高 / 中 / 低） */
  level: Priority
  /** 本层最小最大偏差（固定更高层最优容差后求出）；本层无参与事件时为 null */
  D: number | null
  /** 本层参与整体搜索的期望事件数量 */
  count: number
  /** 本层中达到 |偏差| = D 的事件下标（按事件顺序；空层为空数组） */
  tightEventIdx: number[]
}

/**
 * 分层最小偏差排程结果：
 * 对当前有效差分系统按 高 → 中 → 低 做字典序最小化（D高, D中, D低），
 * 每层在固定更高层最优容差后求本层最小最大偏差；输出一份同时满足全部启用约束
 * 与所有层钉住约束的确定性可行排程。
 */
export interface ScheduleResult {
  /** 每个事件的排程条目（按事件顺序） */
  entries: ScheduleEntry[]
  /** 各层的最优容差与达到 ±D 的事件（按 高 → 中 → 低 顺序） */
  layers: [ScheduleLayerResult, ScheduleLayerResult, ScheduleLayerResult]
  /** 本排程中全部参与期望事件的最大 |偏差|（整数输入下等于各非空层 D 的最大值） */
  maxDeviation: number
  /** 参与整体搜索的期望事件数量（全部非空层之和） */
  desiredCount: number
}

/**
 * 最小修复方案：停用 disableConstraintIds 中的约束后，差分系统恢复可满足。
 */
export interface RepairPlan {
  /** 建议停用的约束 id（按约束录入顺序升序排列） */
  disableConstraintIds: string[]
  /** 停用上述约束后，每个事件相对锚点的时间窗 */
  windows: Map<number, WindowInfo>
}

/** 最小修复搜索结果 */
export interface RepairSearchResult {
  /** 是否找到至少一个可满足修复方案 */
  found: boolean
  /** 并列最优方案，最多 5 个，按需停用约束的录入顺序稳定排序 */
  plans: RepairPlan[]
  /** 已找到的并列最优方案总数（可能大于 plans.length；截断时为下界） */
  totalPlans: number
  /** 每个方案需停用的约束数量（found 为 true 时即已证明的最小停用数） */
  disableCount: number
  /** 是否因达到累计状态数上限而提前停止（结果可能不完备） */
  truncated: boolean
  /** 最小停用数是否已被证明（found 为 true 时恒为 true） */
  optimumProven: boolean
  /** 累计访问的搜索状态数 */
  statesVisited: number
  /** 状态数上限（默认 2000） */
  stateLimit: number
}
