<script lang="ts">
  import type { CompareState } from '../compare/compare.svelte';
  import CanvasView from './CanvasView.svelte';
  import { SIDE_KEYS, SIDE_STATUS_LABEL, sideDisplayStatus, type SideKey } from '../compare/types';

  let { cmp, hover, onhover }: { cmp: CompareState; hover: { x: number; y: number } | null; onhover: (h: { x: number; y: number } | null) => void } = $props();
  const job = $derived(cmp.active);

  function rgbaOf(k: SideKey) {
    const r = job?.sides[k].result;
    return r?.status === 'done' ? (r.softProofRGBA ?? null) : null;
  }
  function subtitleOf(k: SideKey): string {
    if (!job) return '';
    const sp = job.sides[k].spec;
    if (!sp.targetProfileId) return '未配置目标';
    return `${sp.intent} · BPC ${sp.blackPointCompensation ? '开' : '关'} · 打样 ${sp.proofIntent}`;
  }
</script>

{#if job}
  <div class="cmp-grid">
    {#each SIDE_KEYS as k (k)}
      {@const st = sideDisplayStatus(job, k)}
      {@const res = job.sides[k].result}
      <div class="cmp-side cmp-{k} stack">
        <CanvasView
          title={`条件 ${k} · ${job.sides[k].spec.targetDescription || '未配置目标'}`}
          subtitle={subtitleOf(k)}
          width={job.image.width}
          height={job.image.height}
          rgba={rgbaOf(k)}
          displayMode="softproof"
          pins={job.pins}
          {hover}
          onmove={(x, y) => onhover({ x, y })}
          onleave={() => onhover(null)}
          onpin={(x, y) => cmp.addPin(job.id, x, y)}
          accent={k === 'A' ? '#5aa7ff' : '#ffb454'}
        />
        <div class="row side-line">
          <span class="badge side-status status-{st}">{SIDE_STATUS_LABEL[st]}</span>
          {#if st === 'failed' && res?.error}
            <span class="danger small">失败：{res.error}</span>
          {/if}
          {#if st === 'stale'}
            <span class="warn small">显示的是旧条件结果（已过期）</span>
          {/if}
          {#if st === 'pending'}
            <span class="muted small">条件已就绪，尚未运行</span>
          {/if}
          {#if st === 'empty'}
            <span class="muted small">请先在左侧选择条件 {k} 的目标配置</span>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{:else}
  <div class="panel muted empty-hint">
    尚未打开对比作业。在左侧「从当前原稿与已确认源配置新建对比」，或打开已保存的对比快照。
  </div>
{/if}

<style>
  .cmp-grid {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .cmp-side {
    min-width: 0;
    min-height: 0;
  }
  .side-line {
    padding: 0 2px;
  }
  .empty-hint {
    padding: 24px;
    text-align: center;
  }
  .status-running { color: var(--accent); border-color: var(--accent); }
  .status-done { color: var(--accent-2); border-color: #2f6b4c; }
  .status-failed { color: var(--danger); border-color: #6b2f2f; }
  .status-stale { color: var(--warn); border-color: #7a5a23; }
</style>
