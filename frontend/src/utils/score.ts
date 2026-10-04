/**
 * 评分工具：极差归一、阈值分段、加权求和、等级阈值判定、否决短路。
 * 全部为纯函数，便于 useRanking 与各处复用。
 */
import type { Campsite } from '@/types/campsite'
import { ASPECT_SCORE } from '@/types/campsite'
import type { FactorAssessment, RockfallRisk } from '@/types/factor'
import { ROCKFALL_SCORE } from '@/types/factor'
import type { FactorKey, FactorMeta, FactorWeights, GradeThresholds, NormalizeMethod, ScoreScope } from '@/types/score'
import { FACTOR_META, MIN_GROUP_FOR_MINMAX } from '@/types/score'

/** 推荐等级 */
export type Grade = 'A' | 'B' | 'C'

/** 单个因子在某营位上的原始指标值 */
export interface RawFactorValues {
  slope: number
  flatness: number
  aspect: number
  waterDistance: number
  wind: number
  signal: number
  sun: number
  rockfall: number
  shade: number
  distanceToCar: number
  distanceToTrail: number
}

/** 归一化后的单因子明细 */
export interface FactorScoreRow {
  key: FactorKey
  label: string
  unit: string
  higherIsBetter: boolean
  raw: number
  /** 归一化得分 0-100 */
  normalized: number
  /** 权重（0-100） */
  weight: number
  /** 权重占全部有效权重的比例，0-1 */
  weightRatio: number
  /** 计入综合得分的贡献值 = normalized * weightRatio */
  contribution: number
}

/** 一个营位的完整评分结果 */
export interface SiteScore {
  siteId: number
  total: number
  grade: Grade
  rows: FactorScoreRow[]
  vetoed: boolean
  vetoTypes: string[]
}

export function clamp(value: number, min = 0, max = 100): number {
  if (Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 极差归一：把一组数值线性映射到 0-100；higherIsBetter=false 时反向。 */
export function minmaxNormalize(values: number[], higherIsBetter: boolean): number[] {
  if (values.length === 0) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (max - min < 1e-9) return values.map(() => 100)
  return values.map((v) => {
    const base = ((v - min) / (max - min)) * 100
    return clamp(higherIsBetter ? base : 100 - base)
  })
}

/** 阈值分段：按 breaks 落档，得到 100 / 80 / 60 / 40 / 20 五档分。 */
export function thresholdNormalize(value: number, meta: FactorMeta): number {
  const steps = [100, 80, 60, 40, 20]
  const b = meta.breaks
  if (meta.higherIsBetter) {
    for (let i = 0; i < b.length; i += 1) {
      if (value <= b[i]) return steps[i]
    }
    return steps[steps.length - 1]
  }
  for (let i = 0; i < b.length; i += 1) {
    if (value <= b[i]) return steps[i]
  }
  return steps[steps.length - 1]
}

/** 风因子：风力越大越差（0 级 = 100 分，每级 -14 分，最低 16 分）。 */
export function windScore(force: number): number {
  return clamp(100 - Math.max(0, force) * 14, 16, 100)
}

/** 由营位 + 因子评估折算原始指标值；缺少评估记录时给保守缺省值。 */
export function rawValuesOf(site: Campsite, factor?: FactorAssessment | null): RawFactorValues {
  return {
    slope: Number(site.slope) || 0,
    flatness: Number(site.flatness) || 0,
    aspect: ASPECT_SCORE[site.aspect] ?? 70,
    waterDistance: factor ? Number(factor.waterDistance) || 0 : 400,
    wind: factor ? Number(factor.windForce) || 0 : 3,
    signal: factor ? Number(factor.signalBars) || 0 : 0,
    sun: factor ? Number(factor.sunHours) || 0 : 3,
    rockfall: factor ? ROCKFALL_SCORE[factor.rockfallRisk as RockfallRisk] ?? 60 : 50,
    shade: factor ? Number(factor.shade) || 0 : 30,
    distanceToCar: factor ? Number(factor.distanceToCar) || 0 : 300,
    distanceToTrail: factor ? Number(factor.distanceToTrail) || 0 : 200
  }
}

/** 批量归一化的输入条目：营位 id、所属营地与原始指标值。 */
export interface NormalizeEntry {
  siteId: number
  campName: string
  values: RawFactorValues
}

/** 单个营位实际采用的归一化方式与比较组大小。 */
export interface NormalizeGroupInfo {
  method: NormalizeMethod
  /** 参与比较的营位数（同组大小） */
  size: number
}

/** 批量归一化结果：归一化矩阵 + 每个营位的分组信息。 */
export interface NormalizeContext {
  matrix: Map<number, Record<FactorKey, number>>
  groupOf: Map<number, NormalizeGroupInfo>
}

/**
 * 按评分口径把营位分组：
 * - whole：全部营位一组
 * - camp：按所属营地分组
 * - threshold：不分组（阈值分段逐营位计算，分组无意义）
 */
function buildGroups(
  entries: NormalizeEntry[],
  scope: ScoreScope
): Array<{ key: string; items: NormalizeEntry[] }> {
  if (scope === 'camp') {
    const byCamp = new Map<string, NormalizeEntry[]>()
    for (const e of entries) {
      const list = byCamp.get(e.campName) ?? []
      list.push(e)
      byCamp.set(e.campName, list)
    }
    return Array.from(byCamp, ([key, items]) => ({ key, items }))
  }
  return [{ key: '__all__', items: entries }]
}

/** 比较组的实际归一化方式：阈值口径恒为 threshold；其余口径组内营位少于阈值时回退为 threshold。 */
function effectiveMethod(scope: ScoreScope, groupSize: number): NormalizeMethod {
  if (scope === 'threshold') return 'threshold'
  if (groupSize < MIN_GROUP_FOR_MINMAX) return 'threshold'
  return 'minmax'
}

/**
 * 批量归一化：极差归一需要同一批营位一起比较，所以先收集全部原始值再按口径分组归一。
 * 返回归一化矩阵与每个营位的分组信息（实际方法、比较组大小）。
 */
export function buildNormalizeContext(
  entries: NormalizeEntry[],
  scope: ScoreScope
): NormalizeContext {
  const matrix = new Map<number, Record<FactorKey, number>>()
  const groupOf = new Map<number, NormalizeGroupInfo>()

  const groups = buildGroups(entries, scope)

  // 记录每个营位的分组信息
  for (const group of groups) {
    const method = effectiveMethod(scope, group.items.length)
    for (const e of group.items) {
      groupOf.set(e.siteId, { method, size: group.items.length })
    }
  }

  // 逐因子、逐组计算归一化得分
  const columns = FACTOR_META.map((meta) => {
    const col = new Map<number, number>()
    for (const group of groups) {
      const method = effectiveMethod(scope, group.items.length)
      if (method === 'minmax') {
        const values = group.items.map((e) => e.values[meta.key])
        const normalized = minmaxNormalize(values, meta.higherIsBetter)
        group.items.forEach((e, i) => col.set(e.siteId, normalized[i]))
      } else {
        for (const e of group.items) {
          if (meta.key === 'wind') {
            col.set(e.siteId, windScore(e.values.wind))
          } else {
            col.set(e.siteId, thresholdNormalize(e.values[meta.key], meta))
          }
        }
      }
    }
    return col
  })

  // 按营位组装归一化记录
  for (const e of entries) {
    const record = {} as Record<FactorKey, number>
    FACTOR_META.forEach((meta, i) => {
      record[meta.key] = clamp(Math.round(columns[i].get(e.siteId) ?? 0))
    })
    matrix.set(e.siteId, record)
  }

  return { matrix, groupOf }
}

/**
 * 批量归一化（兼容旧调用）：只返回 siteId -> 各因子归一化分值。
 * 新代码请使用 buildNormalizeContext 以同时获取分组信息。
 */
export function buildNormalizedMatrix(
  raws: Array<{ siteId: number; values: RawFactorValues }>,
  method: NormalizeMethod
): Map<number, Record<FactorKey, number>> {
  const scope: ScoreScope = method === 'threshold' ? 'threshold' : 'whole'
  const entries: NormalizeEntry[] = raws.map((r) => ({
    siteId: r.siteId,
    campName: '',
    values: r.values
  }))
  return buildNormalizeContext(entries, scope).matrix
}

/** 加权求和：按有效权重占比归一，保证权重和不为 100 时得分依然可比。 */
export function weightedTotal(normalized: Record<FactorKey, number>, weights: FactorWeights): number {
  let sum = 0
  let weightSum = 0
  FACTOR_META.forEach((meta) => {
    const w = Math.max(0, Number(weights[meta.key]) || 0)
    if (w <= 0) return
    sum += clamp(normalized[meta.key]) * w
    weightSum += w
  })
  if (weightSum <= 0) return 0
  return round1(sum / weightSum)
}

/** 等级阈值判定；命中否决项时最高只能评 B，短路为 C。 */
export function gradeOf(total: number, thresholds: GradeThresholds, vetoed: boolean): Grade {
  const a = Number(thresholds.gradeA) || 80
  const b = Number(thresholds.gradeB) || 60
  if (vetoed) return 'C'
  if (total >= a) return 'A'
  if (total >= b) return 'B'
  return 'C'
}

/** 组装单个营位的因子明细行（含权重占比与贡献值）。 */
export function buildFactorRows(
  normalized: Record<FactorKey, number>,
  weights: FactorWeights
): FactorScoreRow[] {
  const weightSum = FACTOR_META.reduce(
    (acc, meta) => acc + Math.max(0, Number(weights[meta.key]) || 0),
    0
  )
  return FACTOR_META.map((meta) => {
    const weight = Math.max(0, Number(weights[meta.key]) || 0)
    const weightRatio = weightSum > 0 ? weight / weightSum : 0
    return {
      key: meta.key,
      label: meta.label,
      unit: meta.unit,
      higherIsBetter: meta.higherIsBetter,
      raw: 0,
      normalized: clamp(normalized[meta.key]),
      weight,
      weightRatio,
      contribution: round1(clamp(normalized[meta.key]) * weightRatio)
    }
  })
}

/** 权重合计，用于校验表单。 */
export function weightSum(weights: FactorWeights): number {
  return FACTOR_META.reduce((acc, meta) => acc + Math.max(0, Number(weights[meta.key]) || 0), 0)
}

/** 等级对应的展示色（标签、地图标记共用）。 */
export const GRADE_COLOR: Record<Grade, string> = {
  A: '#15803d',
  B: '#d97706',
  C: '#b91c1c'
}

export const GRADE_LABEL: Record<Grade, string> = {
  A: 'A 级 · 优先推荐',
  B: 'B 级 · 可作备选',
  C: 'C 级 · 不建议'
}
