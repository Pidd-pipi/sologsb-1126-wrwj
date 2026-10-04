/**
 * useRanking —— 读取营位、因子、权重与否决记录，算出归一化得分与名次。
 * 被 `/`（名次表）、`/scoring`（拖动权重实时重排）、`/map`、`/sites/:id`、`/veto` 共同消费。
 *
 * 比较口径（scope）：
 * - all：全库同尺，全部营位一批做极差归一，给出全局名次；
 * - camp：按营地分段，每段独立归一化、独立排名，大小营地互不拉偏；
 *   任一段营位少于 MIN_SEGMENT_SIZE 个时，该段自动改走阈值分段，避免一个离群值定名次。
 *
 * 入参统一用 getter 函数，兼容 ref / computed / store 派生值，
 * 内部在独立 effectScope 中求值，保证 computed 依赖追踪正常且不泄漏。
 */
import { computed, effectScope, type ComputedRef } from 'vue'
import type { Campsite } from '@/types/campsite'
import type { FactorAssessment } from '@/types/factor'
import type {
  FactorKey,
  FactorWeights,
  GradeThresholds,
  NormalizeMethod,
  ScoreScope
} from '@/types/score'
import {
  buildFactorRows,
  buildSegments,
  gradeOf,
  rawValuesOf,
  weightedTotal,
  type Grade,
  type RawFactorValues,
  type ScoreSegment,
  type SiteScore
} from '@/utils/score'

export interface RankingInput {
  /** 参与排名的营位集合（完整比较范围；页面筛选不应缩小它，否则会改变极差尺子） */
  sites: () => Campsite[]
  /** siteId -> 用于评分的因子记录（通常取最新一轮评估） */
  factorOf: (siteId: number) => FactorAssessment | null
  weights: () => FactorWeights
  normalize: () => NormalizeMethod
  /** 比较口径：全库同尺 / 按营地分段，缺省沿用全库 */
  scope?: () => ScoreScope
  thresholds: () => GradeThresholds
  /** 命中否决项的营位 id 集合 */
  vetoedIds: () => number[]
}

export interface RankingSegmentSummary {
  key: string
  label: string
  /** 方案声明的归一化方式 */
  method: NormalizeMethod
  /** 段内实际生效的归一化方式（小样本兜底后可能与 method 不同） */
  effectiveMethod: NormalizeMethod
  /** 是否触发了小样本阈值分段兜底 */
  fallback: boolean
  /** 段内参与比较的营位数（含营位自身） */
  size: number
}

export interface RankingRow extends SiteScore {
  site: Campsite
  /** 段内名次（全库口径即全局名次） */
  rank: number
  raw: RawFactorValues
  /** 实际采用的比较口径 */
  scope: ScoreScope
  /** 所属比较段标识与展示名 */
  segmentKey: string
  segmentLabel: string
  /** 段内参与比较的营位数 */
  peerCount: number
  /** 方案声明的归一化方式 */
  method: NormalizeMethod
  /** 该营位实际生效的归一化方式（小样本段会兜底为阈值分段） */
  effectiveMethod: NormalizeMethod
  /** 该营位所在段是否触发了小样本兜底 */
  fallback: boolean
  vetoTypes: string[]
}

export interface RankingState {
  /** 已按口径排序的名次：全库口径全局降序；按营地口径先按营地分段、段内降序 */
  ranked: ComputedRef<RankingRow[]>
  /** 各比较段的口径与规模概览 */
  segments: ComputedRef<RankingSegmentSummary[]>
  scoreOf: (siteId: number) => RankingRow | null
  gradeOfSite: (siteId: number) => Grade
  /** 全局最高分营位（不受分段排序影响，供评分页概览使用） */
  best: ComputedRef<RankingRow | null>
}

export function useRanking(input: RankingInput): RankingState {
  const scope = effectScope(true)

  const result = scope.run(() =>
    computed(() => {
      const sites = input.sites() ?? []
      const normalize = input.normalize()
      const scoreScope = input.scope?.() ?? 'all'
      const weights = input.weights()
      const thresholds = input.thresholds()
      const vetoSet = new Set(input.vetoedIds() ?? [])

      const list = sites.filter((s): s is Campsite & { id: number } => typeof s.id === 'number')

      // 极差归一必须**同批营位一起比较**：按口径切成比较段，每段一次性归一化，再回填。
      // 小样本段（营位 < 3）在 buildSegments 内已自动兜底为阈值分段。
      const entries = list.map((site) => ({
        siteId: site.id,
        campName: site.campName,
        values: rawValuesOf(site, input.factorOf(site.id))
      }))
      const segments = buildSegments(entries, normalize, scoreScope)
      const segmentOf = new Map<number, ScoreSegment<number>>()
      for (const seg of segments) {
        for (const entry of seg.entries) segmentOf.set(entry.siteId, seg)
      }

      const rows: RankingRow[] = list.map((site, idx) => {
        const siteId = site.id
        const raw = entries[idx].values
        const seg = segmentOf.get(siteId)
        const normalized = seg?.matrix.get(siteId) ?? ({} as Record<FactorKey, number>)
        const vetoed = vetoSet.has(siteId)
        const total = weightedTotal(normalized, weights)
        return {
          site,
          siteId,
          total,
          grade: gradeOf(total, thresholds, vetoed),
          vetoed,
          vetoTypes: [],
          rows: buildFactorRows(normalized, weights).map((row) => ({ ...row, raw: raw[row.key] })),
          raw,
          rank: 0,
          scope: scoreScope,
          segmentKey: seg?.key ?? 'all',
          segmentLabel: seg?.label ?? '全部营位',
          peerCount: seg?.entries.length ?? 0,
          method: seg?.method ?? normalize,
          effectiveMethod: seg?.effectiveMethod ?? normalize,
          fallback: seg?.fallback ?? false
        } satisfies RankingRow
      })

      // 段内各自排名（得分降序，同分按营位 id 稳定排序）。
      const rowsBySegment = new Map<string, RankingRow[]>()
      for (const row of rows) {
        const bucket = rowsBySegment.get(row.segmentKey) ?? []
        bucket.push(row)
        rowsBySegment.set(row.segmentKey, bucket)
      }
      for (const bucket of rowsBySegment.values()) {
        bucket.sort((a, b) => b.total - a.total || a.siteId - b.siteId)
        bucket.forEach((row, index) => {
          row.rank = index + 1
        })
      }

      // 全库口径：全局一条名次；按营地口径：先聚合同段，段间按营地名排序。
      const sorted =
        scoreScope === 'camp'
          ? segments.flatMap((seg) =>
              (rowsBySegment.get(seg.key) ?? []).slice().sort((a, b) => a.rank - b.rank)
            )
          : rows.slice().sort((a, b) => b.total - a.total || a.siteId - b.siteId)

      const summaries: RankingSegmentSummary[] = segments.map((seg) => ({
        key: seg.key,
        label: seg.label,
        method: seg.method,
        effectiveMethod: seg.effectiveMethod,
        fallback: seg.fallback,
        size: seg.entries.length
      }))

      return { rows: sorted, segments: summaries }
    })
  )!

  const ranked = scope.run(() => computed<RankingRow[]>(() => result.value.rows)) as ComputedRef<RankingRow[]>
  const segmentSummaries = scope.run(
    () => computed<RankingSegmentSummary[]>(() => result.value.segments)
  ) as ComputedRef<RankingSegmentSummary[]>

  function scoreOf(siteId: number): RankingRow | null {
    return result.value.rows.find((r) => r.siteId === siteId) ?? null
  }

  function gradeOfSite(siteId: number): Grade {
    return scoreOf(siteId)?.grade ?? 'C'
  }

  const best = scope.run(() =>
    computed<RankingRow | null>(() => {
      const all = result.value.rows
      if (!all.length) return null
      return all.reduce((top, row) => (row.total > top.total ? row : top), all[0])
    })
  ) as ComputedRef<RankingRow | null>

  return {
    ranked,
    segments: segmentSummaries,
    scoreOf,
    gradeOfSite,
    best
  }
}
