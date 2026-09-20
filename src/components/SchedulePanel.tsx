import type { Priority, ScheduleResult, TEvent, WindowInfo } from '../types'
import { PRIORITY_LABEL, PRIORITY_LEVELS } from '../types'
import { formatAbsolute, formatOffset } from '../lib/format'

interface Props {
  events: TEvent[]
  anchorId: string | null
  anchorTime: string
  desiredTimes: Record<string, string>
  desiredPriorities: Record<string, Priority>
  /** 有效约束系统是否可满足；矛盾时不展示任何旧排程结果 */
  satisfiable: boolean
  anchorExists: boolean
  /** 有效时间窗（用于识别未与锚点连通的事件） */
  windows: Map<number, WindowInfo>
  /** 排程结果；无可参与期望时为 null */
  schedule: ScheduleResult | null
  onDesiredChange: (eventId: string, iso: string | null) => void
  onPriorityChange: (eventId: string, priority: Priority) => void
}

/** 偏差展示：+5 分钟 / −3 分钟 / 0 分钟 */
function deviationText(d: number): string {
  if (d === 0) return '0 分钟'
  return `${d > 0 ? '+' : '−'}${Math.abs(d)} 分钟`
}

/**
 * 分层最小偏差排程面板：为非锚点事件填写期望时刻并选择高/中/低层级，
 * 系统对**同一个整体差分系统**按 高 → 中 → 低 做字典序最小化：
 * 先求高优先级的最小最大偏差，固定其最优容差后再求下一层
 * （不是加权和，也不是分别排程后拼接），最终输出一份同时满足
 * 全部启用约束的确定性可行排程。任何编辑都会触发实时重算；
 * 约束矛盾时不展示任何旧结果。
 */
export default function SchedulePanel({
  events,
  anchorId,
  anchorTime,
  desiredTimes,
  desiredPriorities,
  satisfiable,
  anchorExists,
  windows,
  schedule,
  onDesiredChange,
  onPriorityChange,
}: Props) {
  const anchorIdx = anchorId != null ? events.findIndex((e) => e.id === anchorId) : -1
  const ready = satisfiable && anchorExists
  const layerByName = new Map(schedule?.layers.map((l) => [l.level, l]))
  const anyDesired = events.some((e) => e.id !== anchorId && !!desiredTimes[e.id])

  const headCount = schedule
    ? PRIORITY_LEVELS.map((lv) => {
        const l = schedule.layers.find((x) => x.level === lv)!
        return `${PRIORITY_LABEL[lv]} D${l.D === null ? '—' : ` = ${l.D}`}`
      }).join(' · ') + ` · ${schedule.desiredCount} 个期望事件参与整体搜索`
    : '为非锚点事件填写期望时刻并选择层级后自动计算'

  return (
    <div className="panel schedule-panel">
      <h3>
        分层最小偏差排程（高 → 中 → 低）
        <span className="count">{headCount}</span>
      </h3>

      {events.length === 0 && (
        <div className="empty-hint">添加事件、指定锚点并录入约束后，可使用分层最小偏差排程。</div>
      )}

      {events.length > 0 && !satisfiable && (
        <div className="schedule-note danger">
          ⛔ 约束系统存在矛盾，分层最小偏差排程不可用：请先核对证词或按上方修复建议处理。
          矛盾解除前<strong>不展示任何排程结果</strong>（避免误用过期结论）。
        </div>
      )}

      {events.length > 0 && satisfiable && !anchorExists && (
        <div className="schedule-note warn">
          🎯 尚未指定锚点事件：请先在事件列表中点选锚点并设置锚点绝对时间，再填写期望时刻。
        </div>
      )}

      {events.length > 0 && ready && (
        <>
          <div className="desired-title">
            期望时刻与层级（仅非锚点事件；留空则不参与排程；未与锚点连通的事件不参与）。
            层级决定字典序求解顺序：先最小化高优先级的最大偏差，固定其最优容差后再最小化中、低层——
            不使用加权和，也不分别排程后拼接。
          </div>
          <div className="desired-list">
            {events.map((ev, i) => {
              if (i === anchorIdx) return null
              const disconnected = windows.get(i)?.status === 'disconnected'
              const val = desiredTimes[ev.id] ?? ''
              const priority: Priority = desiredPriorities[ev.id] ?? 'medium'
              return (
                <div className="desired-row" key={ev.id}>
                  <span className="name" title={ev.name}>
                    {ev.name}
                  </span>
                  {disconnected && (
                    <span className="badge offlink" title="该事件与锚点没有约束通路，期望时刻不参与排程">
                      未连通
                    </span>
                  )}
                  <input
                    type="datetime-local"
                    value={val}
                    onChange={(e) => onDesiredChange(ev.id, e.target.value || null)}
                    aria-label={`${ev.name} 的期望时刻`}
                  />
                  <select
                    className="priority-select"
                    value={priority}
                    onChange={(e) => onPriorityChange(ev.id, e.target.value as Priority)}
                    aria-label={`${ev.name} 的期望层级`}
                    title={val ? '该期望参与排程的优先级层' : '先填写期望时刻；层级在填写后生效'}
                  >
                    {PRIORITY_LEVELS.map((lv) => (
                      <option key={lv} value={lv}>
                        {PRIORITY_LABEL[lv]}优先级
                      </option>
                    ))}
                  </select>
                  {val && (
                    <button
                      className="small"
                      onClick={() => onDesiredChange(ev.id, null)}
                      title="清除该期望时刻"
                    >
                      清除
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {!schedule && (
            <div className="empty-hint">
              {anyDesired
                ? '已填写的期望时刻均属于未与锚点连通的事件，不参与排程；请为可定时事件填写期望时刻。'
                : '还没有期望时刻：填写后系统将对整体差分系统按 高→中→低 字典序搜索各层最小偏差，并给出一份确定性的可行排程。'}
            </div>
          )}

          {schedule && (
            <>
              {/* 各层最优结果：最优 D、达到 ±D 的事件与参与数 */}
              <div className="layer-results">
                {schedule.layers.map((layer) => {
                  const tightNames = layer.tightEventIdx.map((i) => `「${events[i].name}」`)
                  return (
                    <div className={`layer-card prio-${layer.level}`} key={layer.level}>
                      <div className="layer-head">
                        <span className={`layer-tag prio-${layer.level}`}>
                          {PRIORITY_LABEL[layer.level]}优先级
                        </span>
                        {layer.D === null ? (
                          <span className="layer-d none">本层无参与事件</span>
                        ) : (
                          <span className="layer-d">
                            最优 <span className="dval">D{PRIORITY_LABEL[layer.level]} = {layer.D}</span> 分钟
                          </span>
                        )}
                        <span className="layer-count">{layer.count} 个事件</span>
                      </div>
                      {layer.D !== null && (
                        <div className="layer-tight">
                          {tightNames.length > 0 ? (
                            <>
                              达到 ±D{PRIORITY_LABEL[layer.level]}：{tightNames.join('、')}
                            </>
                          ) : (
                            '本层无事件达到容差边界'
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <div className="schedule-summary">
                <span>
                  字典序最优容差（D高, D中, D低）= (
                  {schedule.layers.map((l) => (l.D === null ? '—' : l.D)).join(', ')}) 分钟
                </span>
                <span className="sep">·</span>
                <span>本排程最大偏差 {schedule.maxDeviation} 分钟</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="windows">
                  <thead>
                    <tr>
                      <th>事件</th>
                      <th>层级</th>
                      <th>状态</th>
                      <th className="num">实际时刻</th>
                      <th className="num">相对锚点</th>
                      <th className="num">期望时刻</th>
                      <th className="num">期望偏差</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.entries.map((en) => {
                      const ev = events[en.eventIdx]
                      const layer = en.priority ? layerByName.get(en.priority) : undefined
                      const tight = !!layer && layer.D !== null && en.deviation !== null &&
                        Math.abs(en.deviation) === layer.D && en.status === 'scheduled'
                      return (
                        <tr key={ev.id}>
                          <td>
                            {ev.name}
                            {en.status === 'unscheduled' && (
                              <div style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>
                                未与锚点连通{en.desiredIgnored && '，期望时刻未生效'}
                              </div>
                            )}
                          </td>
                          <td>
                            {en.priority ? (
                              <span className={`layer-tag prio-${en.priority}`}>
                                {PRIORITY_LABEL[en.priority]}
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td>
                            {en.status === 'anchor' && <span className="status-pill anchor">锚点</span>}
                            {en.status === 'scheduled' && (
                              <span className="status-pill bounded">已定时</span>
                            )}
                            {en.status === 'unscheduled' && (
                              <span
                                className="status-pill disconnected"
                                title="与锚点没有任何约束通路，无法定时"
                              >
                                未定时
                              </span>
                            )}
                          </td>
                          <td className="num">
                            {en.offsetMin !== null ? formatAbsolute(anchorTime, en.offsetMin) : '—'}
                          </td>
                          <td className="num">
                            {en.offsetMin !== null ? formatOffset(en.offsetMin) : '—'}
                          </td>
                          <td className="num">
                            {en.desiredOffset !== null
                              ? formatAbsolute(anchorTime, en.desiredOffset)
                              : '—'}
                          </td>
                          <td className="num">
                            {en.deviation !== null ? (
                              <>
                                {deviationText(en.deviation)}
                                {tight && (
                                  <span
                                    className={`badge tight prio-${en.priority}`}
                                    title={`该事件的偏差达到${PRIORITY_LABEL[en.priority!]}优先级层最优 D = ${layer?.D} 分钟`}
                                  >
                                    达到 ±D
                                  </span>
                                )}
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
