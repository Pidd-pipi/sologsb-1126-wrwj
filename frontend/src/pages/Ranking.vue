<script setup lang="ts">
/**
 * `/` 营位名次表 —— 按综合得分从高到低排序，展示坡度、水源距离、信号与等级，
 * 可按营地 / 地表类型 / 进出方式筛选，命中否决项的营位整行标红。
 * 消费 Campsite、FactorAssessment、RiskVeto；复用 <GradeBadge>、<EmptyState>。
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useSiteStore } from '@/stores/siteStore'
import { useProfileStore } from '@/stores/profileStore'
import { useUiStore } from '@/stores/uiStore'
import { useRanking } from '@/hooks/useRanking'
import { FACTOR_META, NORMALIZE_LABELS, SCOPE_LABELS } from '@/types/score'
import { SURFACE_TYPES, ACCESS_MODES } from '@/types/campsite'
import GradeBadge from '@/components/common/GradeBadge.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { formatScore } from '@/utils/format'

const router = useRouter()
const siteStore = useSiteStore()
const profileStore = useProfileStore()
const uiStore = useUiStore()

const inputSites = computed(() =>
  siteStore.list.filter((site) => {
    if (uiStore.filterCamp && site.campName !== uiStore.filterCamp) return false
    if (uiStore.filterSurface && site.surface !== uiStore.filterSurface) return false
    if (uiStore.filterAccess && site.access !== uiStore.filterAccess) return false
    const kw = uiStore.keyword.trim()
    if (kw) {
      const hay = `${site.code} ${site.name} ${site.campName} ${site.note}`
      if (!hay.includes(kw)) return false
    }
    return true
  })
)

/**
 * 比较范围始终取全库营位：页面筛选只决定展示哪些行，
 * 若把筛选结果喂给极差归一，尺子会随筛选变化、名次失去意义。
 */
const { ranked, segments } = useRanking({
  sites: () => siteStore.list,
  factorOf: (siteId: number) => siteStore.latestFactor(siteId),
  weights: () => profileStore.activeWeights,
  scope: () => profileStore.activeScope,
  normalize: () => profileStore.activeProfile?.normalize ?? 'minmax',
  thresholds: () => profileStore.activeProfile?.thresholds ?? { gradeA: 78, gradeB: 58 },
  vetoedIds: () => uiStore.vetoedSiteIds
})

/** 当前筛选条件下实际展示的名次行（分数与名次仍按完整比较范围算出） */
const visibleRanked = computed(() =>
  ranked.value.filter((row) => inputSites.value.some((s) => s.id === row.siteId))
)

const activeScopeLabel = computed(() => SCOPE_LABELS[profileStore.activeScope])
const activeNormalizeLabel = computed(() =>
  profileStore.activeProfile ? NORMALIZE_LABELS[profileStore.activeProfile.normalize] : '—'
)

/** 触发小样本兜底的比较段（用于表头口径说明） */
const fallbackSegments = computed(() => segments.value.filter((s) => s.fallback))

const factorMetaOf = (key: string) => FACTOR_META.find((m) => m.key === key)

/** 从某行的因子明细里取某一项的归一化得分，供表格单元格内联展示 */
function normalizedOf(
  row: { rows: Array<{ key: string; normalized: number }> },
  key: string
): number | string {
  return row.rows.find((r) => r.key === key)?.normalized ?? '—'
}

/** 命中否决项的营位整行标红 */
function rowClass({ row }: { row: { vetoed: boolean } }): string {
  return row.vetoed ? 'veto-row' : ''
}

const stats = computed(() => {
  const rows = visibleRanked.value
  // 按营地口径下表格按段排列，最高分需显式取最大值而非第一行
  const topRow = rows.reduce((max, r) => (!max || r.total > max.total ? r : max), null as typeof rows[number] | null)
  return {
    total: rows.length,
    gradeA: rows.filter((r) => r.grade === 'A').length,
    vetoed: rows.filter((r) => r.vetoed).length,
    top: topRow?.total ?? 0,
    topName: topRow ? `${topRow.site.code} ${topRow.site.name}` : '—'
  }
})

const activeProfileName = computed(() => profileStore.activeProfile?.name ?? '—')

function openDetail(siteId: number | undefined): void {
  if (typeof siteId !== 'number') return
  void router.push(`/sites/${siteId}`)
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-head__title">
        <h1>营位名次表</h1>
        <p>
          按当前权重方案对全部候选营位加权求和后降序排列，实时给出 A/B/C 推荐等级；
          命中风险否决项的营位整行标红并自动降为 C 级。
        </p>
      </div>
      <div class="page-actions">
        <el-button @click="router.push('/scoring')">调权重</el-button>
        <el-button @click="router.push('/map')">看地图</el-button>
        <el-button type="primary" @click="router.push('/sites/new')">新增营位</el-button>
      </div>
    </div>

    <div class="stat-row">
      <div class="stat-card">
        <div class="stat-card__label">候选营位</div>
        <div class="stat-card__value" data-testid="stat-total">{{ stats.total }}</div>
        <div class="stat-card__extra">共 {{ siteStore.total }} 个已登记</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">A 级推荐</div>
        <div class="stat-card__value">{{ stats.gradeA }}</div>
        <div class="stat-card__extra">阈值来自当前方案</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">命中否决</div>
        <div class="stat-card__value" :style="{ color: stats.vetoed ? '#b91c1c' : undefined }">
          {{ stats.vetoed }}
        </div>
        <div class="stat-card__extra">否决后禁止评 A</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">最高综合得分</div>
        <div class="stat-card__value">{{ formatScore(stats.top) }}</div>
        <div class="stat-card__extra">{{ stats.topName }}</div>
      </div>
    </div>

    <section class="panel">
      <div class="panel__head">
        <h2>筛选条件</h2>
        <span class="weight-note">
          当前方案：{{ activeProfileName }} · 比较口径：{{ activeScopeLabel }} ·
          归一方式：{{ activeNormalizeLabel }}
        </span>
      </div>
      <div class="filters">
        <el-select v-model="uiStore.filterCamp" placeholder="全部营地" clearable style="width: 190px">
          <el-option v-for="c in siteStore.camps" :key="c" :label="c" :value="c" />
        </el-select>
        <el-select
          v-model="uiStore.filterSurface"
          placeholder="全部地表类型"
          clearable
          style="width: 170px"
        >
          <el-option v-for="s in SURFACE_TYPES" :key="s" :label="s" :value="s" />
        </el-select>
        <el-select
          v-model="uiStore.filterAccess"
          placeholder="全部进出方式"
          clearable
          style="width: 170px"
        >
          <el-option v-for="a in ACCESS_MODES" :key="a" :label="a" :value="a" />
        </el-select>
        <el-input
          v-model="uiStore.keyword"
          placeholder="搜索编号 / 名称 / 备注"
          clearable
          style="width: 230px"
        />
        <el-button text @click="uiStore.resetFilters()">清空筛选</el-button>
      </div>
    </section>

    <el-alert
      :closable="false"
      show-icon
      :type="fallbackSegments.length ? 'warning' : 'info'"
      class="scope-alert"
    >
      <template #title>
        当前口径：{{ activeScopeLabel }} · {{ activeNormalizeLabel }}
        <span v-if="profileStore.activeScope === 'camp'">
          （共 {{ segments.length }} 个营地比较段，名次为各营地内部排名，跨营地不比总分）
        </span>
        <span v-else>（共 1 个比较段，全部 {{ siteStore.total }} 个营位同尺排名）</span>
      </template>
      <template #description>
        <span v-if="fallbackSegments.length">
          {{ fallbackSegments.map((s) => `「${s.label}」仅 ${s.size} 个营位`).join('、') }}
          ，少于 3 个时极差归一会被单个离群值带偏，已自动改走阈值分段给分。
        </span>
        <span v-else>
          比较段营位均不少于 3 个，极差归一稳定；营位归属调整或增删营位后，相关比较段会立即重算。
        </span>
      </template>
    </el-alert>

    <section class="panel">
      <div class="panel__head">
        <h2>名次与得分</h2>
        <span class="weight-note">
          显示 {{ visibleRanked.length }} / 共 {{ ranked.length }} 行
        </span>
      </div>

      <el-table
        v-if="visibleRanked.length"
        data-testid="ranking-table"
        :data="visibleRanked"
        :row-class-name="rowClass"
        size="default"
        border
        stripe
      >
        <el-table-column label="名次" width="84" align="center">
          <template #default="{ row }">
            <span class="rank-no" :class="{ 'rank-no--top': row.rank <= 3 }">{{ row.rank }}</span>
            <div v-if="profileStore.activeScope === 'camp'" class="cell-sub">
              段内 {{ row.peerCount }} 个
            </div>
          </template>
        </el-table-column>
        <el-table-column v-if="profileStore.activeScope === 'camp'" label="比较段（营地）" min-width="160">
          <template #default="{ row }">
            {{ row.segmentLabel }}
            <el-tag v-if="row.fallback" type="warning" size="small" effect="plain" class="ml6">
              阈值兜底
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="营位" min-width="210">
          <template #default="{ row }">
            <div class="site-cell">
              <el-link type="primary" underline="never" @click="openDetail(row.site.id)">
                {{ row.site.code }} · {{ row.site.name }}
              </el-link>
              <span class="site-cell__sub">
                {{ row.site.campName }} · 海拔 {{ row.site.elevation }} m · 容 {{ row.site.tentCapacity }} 帐
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="地表 / 进出" width="130">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.site.surface }}</el-tag>
            <el-tag size="small" effect="plain" type="info" class="ml6">{{ row.site.access }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="坡度" width="92" align="right">
          <template #default="{ row }">
            {{ row.raw.slope.toFixed(1) }}°
            <div class="cell-sub">归一 {{ normalizedOf(row, 'slope') }}</div>
          </template>
        </el-table-column>
        <el-table-column label="水源距离" width="104" align="right">
          <template #default="{ row }">
            {{ row.raw.waterDistance }} m
            <div class="cell-sub">归一 {{ normalizedOf(row, 'waterDistance') }}</div>
          </template>
        </el-table-column>
        <el-table-column label="信号" width="92" align="right">
          <template #default="{ row }">
            {{ row.raw.signal }} 格
            <div class="cell-sub">归一 {{ normalizedOf(row, 'signal') }}</div>
          </template>
        </el-table-column>
        <el-table-column label="风力" width="88" align="right">
          <template #default="{ row }">
            {{ row.raw.wind }} 级
            <div class="cell-sub">{{ siteStore.latestFactor(row.siteId)?.windDir ?? '—' }}向</div>
          </template>
        </el-table-column>
        <el-table-column label="日照" width="86" align="right">
          <template #default="{ row }">{{ row.raw.sun.toFixed(1) }} h</template>
        </el-table-column>
        <el-table-column label="综合得分" width="104" align="right">
          <template #default="{ row }">
            <strong class="total-score">{{ formatScore(row.total) }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="等级" width="210">
          <template #default="{ row }">
            <GradeBadge :grade="row.grade" :score="row.total" :vetoed="row.vetoed" />
          </template>
        </el-table-column>
        <el-table-column label="否决项" min-width="180">
          <template #default="{ row }">
            <template v-if="row.vetoed">
              <el-tag v-for="v in uiStore.vetosOf(row.siteId)" :key="v.id" type="danger" size="small" class="mr6">
                {{ v.type }}
              </el-tag>
            </template>
            <span v-else class="muted">无</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="132" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="openDetail(row.site.id)">详情</el-button>
            <el-button size="small" text @click="router.push('/veto')">登记否决</el-button>
          </template>
        </el-table-column>
      </el-table>

      <EmptyState
        v-else
        title="还没有可评估的营位"
        description="先登记候选营位并录入因子（坡度、水源距离、信号、日照等），名次表会自动按得分排序并给出 A/B/C 等级。"
        action-text="新增营位"
        :hint="`因子维度共 ${FACTOR_META.length} 项，全部可在评分页调整权重`"
        @action="router.push('/sites/new')"
      />
    </section>
  </div>
</template>

<style scoped>
.scope-alert {
  margin-bottom: 14px;
}
.rank-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: var(--gb-surface);
  color: var(--gb-muted);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.rank-no--top {
  background: #e6f4ea;
  color: var(--gb-accent-strong);
}
.site-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.site-cell__sub {
  font-size: 11px;
  color: var(--gb-muted);
}
.cell-sub {
  font-size: 11px;
  color: var(--gb-muted);
}
.total-score {
  font-size: 15px;
  color: var(--gb-accent-strong);
  font-variant-numeric: tabular-nums;
}
.ml6 {
  margin-left: 6px;
}
.mr6 {
  margin-right: 6px;
}
</style>
