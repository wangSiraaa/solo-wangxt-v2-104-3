<script lang="ts">
  import type { CompareStore } from '../compare/compare.svelte';
  import { deltaE2000, fromTriple } from '../color/colorMath';
  import { pinSideStale, SIDE_IDS } from '../compare/model';

  let { cmp }: { cmp: CompareStore } = $props();
  const c = cmp.state;
  const job = $derived(c.current);

  const fmtDev = (v: number, cs: string): string => (cs === 'CMYK' ? `${v.toFixed(1)}` : `${(v * 100).toFixed(1)}%`);
  const channelsLabel = (cs: string): string[] =>
    cs === 'CMYK' ? ['C', 'M', 'Y', 'K'] : cs === 'GRAY' ? ['K(灰)'] : ['R', 'G', 'B'];
  const labStr = (t: [number, number, number]) => t.map((v) => v.toFixed(2)).join('  ');
</script>

<div class="panel stack">
  <h2>对比取样（A / B 同坐标）</h2>
  {#if !job}
    <div class="small muted">新建或打开对比作业后，在任一软打样预览上单击钉选取样点。</div>
  {:else if job.pins.length === 0}
    <div class="small muted">
      在 A 或 B 预览上单击钉选。两侧都直接从冻结的原图像素取样，互不以对方结果为输入。
    </div>
  {:else}
    <div class="stack pins scroll">
      {#each job.pins as p, i (i)}
        {@const de = p.a && p.b ? deltaE2000(fromTriple(p.a.targetLab), fromTriple(p.b.targetLab)) : null}
        <div class="pinbox" data-testid="compare-pin">
          <div class="row spread">
            <span class="small muted">#{i + 1} ({p.x}, {p.y})</span>
            <button class="ghost small" onclick={() => cmp.removePin(i)}>移除</button>
          </div>
          {#if p.pending}
            <div class="small muted">计算中…</div>
          {:else}
            <table>
              <thead>
                <tr><th></th><th>设备值</th><th>目标 Lab（D50）</th></tr>
              </thead>
              <tbody>
                {#each SIDE_IDS as side (side)}
                {@const info = side === 'A' ? p.a : p.b}
                {@const err = side === 'A' ? p.aError : p.bError}
                <tr>
                  <td class="muted">{side}</td>
                  <td class="mono">
                    {#if info}
                      {@const ch = channelsLabel(info.targetColorSpace)}
                      {#each ch as cname, k}
                        <span class="chip">{cname} {fmtDev(info.targetDevice[k], info.targetColorSpace)}</span>
                      {/each}
                    {:else if err}
                      <span class="danger small">✗ {err}</span>
                    {:else}
                      <span class="muted small">无样本</span>
                    {/if}
                  </td>
                  <td class="mono">{info ? labStr(info.targetLab) : '—'}</td>
                </tr>
                {/each}
              </tbody>
            </table>
            {#if de !== null}
              <div class="row spread de">
                <span class="muted small">两侧目标 Lab 色差 ΔE00</span>
                <strong class:warn={de >= 2} class:danger={de >= 6} data-testid="pin-deltae">{de.toFixed(2)}</strong>
              </div>
            {/if}
            {#each SIDE_IDS as side (side)}
              {#if pinSideStale(p, job.sides[side], side)}
                <div class="small warn" data-testid="pin-stale-{side}">侧 {side} 条件已改，此样本已过期。</div>
              {/if}
            {/each}
          {/if}
        </div>
      {/each}
    </div>
  {/if}
  <div class="small muted">ΔE 仅量化两条件在同一像素上的数值差异；不代表人眼或实物打样差异。</div>
</div>

<style>
  .pins {
    max-height: 55vh;
  }
  .pinbox {
    border-top: 1px solid var(--line);
    padding-top: 6px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th, td {
    text-align: left;
    vertical-align: top;
    padding: 3px 5px;
    border-bottom: 1px solid #ffffff0d;
    font-size: 12px;
  }
  th {
    color: var(--muted);
    font-weight: 500;
    font-size: 11px;
  }
  .chip {
    display: inline-block;
    margin: 0 4px 2px 0;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 0 5px;
  }
  .de strong {
    font-size: 15px;
  }
</style>
