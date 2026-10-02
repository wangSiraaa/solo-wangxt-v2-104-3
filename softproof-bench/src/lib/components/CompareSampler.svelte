<script lang="ts">
  import type { CompareState } from '../compare/compare.svelte';
  import { deltaE2000, fromTriple } from '../color/colorMath';
  import { sideSpecHash, type ComparePin, type SideKey } from '../compare/types';
  import type { SampleInfo } from '../color/engine';

  let { cmp, hover }: { cmp: CompareState; hover: { x: number; y: number } | null } = $props();
  const job = $derived(cmp.active);

  const channelsLabel = (cs: string): string[] =>
    cs === 'CMYK' ? ['C', 'M', 'Y', 'K'] : cs === 'GRAY' ? ['K(灰)'] : ['R', 'G', 'B'];

  const fmtDev = (v: number, cs: string): string => (cs === 'CMYK' ? v.toFixed(1) : `${(v * 100).toFixed(1)}%`);

  function pinDE(p: ComparePin): number | null {
    if (!p.A || !p.B) return null;
    return deltaE2000(fromTriple(p.A.targetLab), fromTriple(p.B.targetLab));
  }

  function sideStale(p: ComparePin, k: SideKey): boolean {
    if (!job || !p[k]) return false;
    const cur = sideSpecHash(job, job.sides[k].spec);
    return (k === 'A' ? p.specHashA : p.specHashB) !== cur;
  }

  const summaryStale = $derived(
    job && job.summary
      ? job.summary.specHashA !== sideSpecHash(job, job.sides.A.spec) ||
          job.summary.specHashB !== sideSpecHash(job, job.sides.B.spec)
      : false,
  );
</script>

{#if job}
  <div class="panel stack">
    <h2>取样差异（同一坐标 · A / B 对照）</h2>
    <div class="small muted">
      悬停坐标 {hover ? `${hover.x}, ${hover.y}` : '—'}；在任一画布单击钉选，两侧各自从原图取样。
    </div>
    {#if job.pins.length === 0}
      <div class="small muted">尚无钉选点。</div>
    {:else}
      <div class="pins scroll">
        {#each job.pins as p, i (p.id)}
          {@const de = pinDE(p)}
          <div class="pin-row stack">
            <div class="row spread">
              <span class="small mono">#{i + 1} ({p.x}, {p.y})</span>
              <button class="ghost small" onclick={() => cmp.removePin(job.id, p.id)}>移除</button>
            </div>
            {#each ['A', 'B'] as k (k)}
              {@const info = p[k as SideKey]}
              <div class="small">
                <span class="badge">{k}</span>
                {#if info}
                  {@render sideInfo(info)}
                  {#if sideStale(p, k as SideKey)}<span class="badge stale">已过期</span>{/if}
                {:else if p[k === 'A' ? 'errorA' : 'errorB']}
                  <span class="danger">取样失败：{p[k === 'A' ? 'errorA' : 'errorB']}</span>
                {:else}
                  <span class="muted">—（未配置或计算中）</span>
                {/if}
              </div>
            {/each}
            {#if de !== null}
              <div class="row spread de">
                <span class="muted small">ΔE00（A↔B 目标 Lab）</span>
                <strong class:warn={de >= 2} class:danger={de >= 6}>{de.toFixed(2)}</strong>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="panel stack summary-panel">
    <h2>整体比较摘要</h2>
    {#if job.summary && !summaryStale}
      {@const sm = job.summary}
      <table class="small">
        <tbody>
          <tr><td class="muted">取样点数</td><td class="mono">{sm.samples}</td></tr>
          <tr><td class="muted">平均 ΔE00</td><td class="mono">{sm.meanDE.toFixed(3)}</td></tr>
          <tr>
            <td class="muted">最大 ΔE00</td>
            <td class="mono">{sm.maxDE.toFixed(3)} <span class="muted">@ ({sm.maxX}, {sm.maxY})</span></td>
          </tr>
          <tr><td class="muted">ΔE00 &gt; 2 / &gt; 5</td><td class="mono">{sm.over2} / {sm.over5}</td></tr>
          <tr><td class="muted">比较时间</td><td class="mono">{new Date(sm.computedAt).toLocaleString()}</td></tr>
        </tbody>
      </table>
      <div class="small muted">网格取样的两侧目标 Lab 差异；仅量化数值差异，不代表人眼或实物打样差异。</div>
    {:else if job.summary && summaryStale}
      <div class="warn small">条件已修改，摘要已过期。</div>
      <button onclick={() => cmp.computeSummary(job.id)}>按当前条件重新计算摘要</button>
    {:else}
      <div class="small muted">两侧都以当前条件完成后自动计算；也可手动触发。</div>
      <button onclick={() => cmp.computeSummary(job.id)}>计算整体摘要</button>
    {/if}
  </div>
{:else}
  <div class="panel small muted">打开对比作业后，此处显示同点取样差异与整体摘要。</div>
{/if}

{#snippet sideInfo(s: SampleInfo)}
  {@const ch = channelsLabel(s.targetColorSpace)}
  <span class="mono">
    {#each ch as c, i}
      {c} {fmtDev(s.targetDevice[i], s.targetColorSpace)}{i < ch.length - 1 ? ' · ' : ''}
    {/each}
  </span>
  <span class="mono muted">Lab {s.targetLab.map((v) => v.toFixed(2)).join(' ')}</span>
{/snippet}

<style>
  .pins {
    max-height: 320px;
  }
  .pin-row {
    border-top: 1px solid var(--line);
    padding-top: 6px;
    gap: 4px;
  }
  .badge.stale {
    color: var(--warn);
    border-color: #7a5a23;
  }
  .de strong {
    font-size: 15px;
  }
  table {
    border-collapse: collapse;
  }
  td {
    padding: 2px 8px 2px 0;
    text-align: left;
  }
</style>
