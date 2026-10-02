<script lang="ts">
  import type { AppState } from '../db/state.svelte';
  import type { CompareStore } from '../compare/compare.svelte';
  import CanvasView from './CanvasView.svelte';
  import {
    SIDE_IDS,
    SIDE_STATUS_LABEL,
    JOB_STATUS_LABEL,
    effectiveSideStatus,
    summaryStale,
  } from '../compare/model';
  import { INTENT_LABEL, type RenderingIntent } from '../color/lcms';

  let { app, cmp }: { app: AppState; cmp: CompareStore } = $props();
  const s = app.state;
  const c = cmp.state;

  const intents: RenderingIntent[] = [
    'perceptual',
    'relative-colorimetric',
    'saturation',
    'absolute-colorimetric',
  ];

  const createCheck = $derived(cmp.canCreateFrom(app));
  const job = $derived(c.current);
  const anyRunning = $derived(
    job ? SIDE_IDS.some((id) => job.sides[id].running) : false,
  );

  function profileById(id: string) {
    return s.profiles.find((p) => p.id === id);
  }
</script>

<div class="stack compare">
  <div class="panel stack">
    <div class="row spread">
      <h2>打样条件对比 <span class="muted small">同一原稿 · 同一已确认源配置 · 两套独立目标条件</span></h2>
      {#if job}
        <span class="badge job-{job.status}" data-testid="job-status">{JOB_STATUS_LABEL[job.status]}</span>
      {/if}
    </div>

    {#if !job}
      <div class="small muted">
        以当前原稿与已确认源配置为起点，冻结 A/B 两套目标条件（目标配置、渲染意图、黑点补偿、软打样意图），
        两侧分别从原图直接计算软打样预览，互不以对方结果为输入。作业保存于本机 IndexedDB。
      </div>
      <div class="row">
        <button
          class="primary"
          data-testid="new-compare-job"
          disabled={!createCheck.ok}
          onclick={() => cmp.newFromCurrent(app)}
        >
          从当前原稿新建对比作业
        </button>
      </div>
      {#if !createCheck.ok}
        <div class="small warn" data-testid="create-blocked">{createCheck.reason}</div>
      {/if}
    {:else}
      <div class="row jobbar">
        <input
          class="jobname"
          type="text"
          value={job.name}
          data-testid="job-name"
          onchange={(e) => cmp.renameJob((e.currentTarget as HTMLInputElement).value)}
        />
        <button class="primary" data-testid="run-all" disabled={anyRunning} onclick={() => cmp.runAll()}>
          {anyRunning ? '运行中…' : '运行两侧'}
        </button>
        <button data-testid="cancel-run" disabled={!anyRunning} onclick={() => cmp.cancel()}>取消运行</button>
        <button data-testid="export-record" onclick={() => cmp.exportRecord()}>导出对比记录</button>
        <button class="ghost" data-testid="close-job" onclick={() => cmp.closeJob()}>关闭作业</button>
      </div>
      <div class="small muted" data-testid="job-frozen">
        原稿 <strong>{job.image.name}</strong>（{job.image.container.toUpperCase()} {job.image.bitDepth}-bit · 哈希 {job.image.hash.slice(0, 12)}…）
        · 源配置 <strong>{job.source.description}</strong>
        {#if job.source.origin === 'assumed'}<span class="badge">人工假设</span>{:else}<span class="badge embedded">嵌入 ICC</span>{/if}
        · 指纹 {job.source.fingerprint.slice(0, 12)}… —— 均已冻结，不受主面板当前选择影响。
      </div>
    {/if}
    {#if c.notice}
      <div class="small muted" data-testid="compare-notice">{c.notice}</div>
    {/if}
  </div>

  {#if job}
    <div class="sidecards">
      {#each SIDE_IDS as side (side)}
        {@const sd = job.sides[side]}
        {@const st = effectiveSideStatus(sd)}
        <div class="panel stack sidecard">
          <div class="row spread">
            <strong>条件 {side}</strong>
            <span class="badge side-{st}" data-testid="side-status-{side}">{SIDE_STATUS_LABEL[st]}</span>
          </div>
          <label class="field">
            目标配置
            <select
              data-testid="target-{side}"
              value={sd.config?.targetProfileId ?? ''}
              onchange={(e) => {
                const p = profileById((e.currentTarget as HTMLSelectElement).value);
                if (p) cmp.setSideProfile(side, p);
              }}
            >
              <option value="" disabled>-- 选择目标配置 --</option>
              {#each s.profiles as p (p.id)}
                <option value={p.id}>{p.description} [{p.colorSpace}]</option>
              {/each}
            </select>
          </label>
          {#if sd.config}
            <div class="row params">
              <label class="field">
                渲染意图
                <select
                  data-testid="intent-{side}"
                  value={sd.config.intent}
                  onchange={(e) =>
                    cmp.setSideParams(side, { intent: (e.currentTarget as HTMLSelectElement).value as RenderingIntent })}
                >
                  {#each intents as i}
                    <option value={i}>{INTENT_LABEL[i]}</option>
                  {/each}
                </select>
              </label>
              <label class="row check">
                <input
                  type="checkbox"
                  data-testid="bpc-{side}"
                  checked={sd.config.blackPointCompensation}
                  onchange={(e) => cmp.setSideParams(side, { blackPointCompensation: (e.currentTarget as HTMLInputElement).checked })}
                />
                <span>黑点补偿</span>
              </label>
              <label class="field">
                软打样意图
                <select
                  data-testid="proof-{side}"
                  value={sd.config.proofIntent}
                  onchange={(e) =>
                    cmp.setSideParams(side, { proofIntent: (e.currentTarget as HTMLSelectElement).value as RenderingIntent })}
                >
                  <option value="relative-colorimetric">相对色度</option>
                  <option value="absolute-colorimetric">绝对色度</option>
                  <option value="perceptual">感知式</option>
                  <option value="saturation">饱和度</option>
                </select>
              </label>
            </div>
            <div class="mono small muted" data-testid="fingerprint-{side}">
              条件指纹 {sd.config.fingerprint}（{sd.config.colorSpace} · 配置 {sd.config.profileFingerprint.slice(0, 8)}…）
            </div>
          {/if}
          <button
            data-testid="run-{side}"
            disabled={!sd.config || sd.running}
            onclick={() => cmp.runSide(side)}
          >
            {sd.running ? '运行中…' : st === 'failed' ? `重试 ${side}` : st === 'done' ? `重新运行 ${side}` : st === 'stale' ? `重新运行 ${side}（条件已改）` : `运行 ${side}`}
          </button>
          {#if st === 'stale'}
            <div class="small warn" data-testid="stale-{side}">条件已修改，此前结果已过期；画面保留供对照。</div>
          {/if}
          {#if sd.error}
            <div class="small danger" data-testid="error-{side}">
              ✗ 失败证据：{sd.error}{#if sd.failedAt}（{new Date(sd.failedAt).toLocaleTimeString()}）{/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <div class="cmp-canvases">
      {#each SIDE_IDS as side (side)}
        {@const sd = job.sides[side]}
        <div class="cmp-stage cmp-stage-{side}">
          <CanvasView
            title={`${side} 软打样预览`}
            subtitle={sd.config
              ? `${sd.config.description} · ${sd.config.intent} · BPC ${sd.config.blackPointCompensation ? '开' : '关'}`
              : '未选择目标配置'}
            width={sd.result?.width ?? 0}
            height={sd.result?.height ?? 0}
            rgba={sd.result?.softProofRGBA ?? null}
            displayMode="softproof"
            pins={job.pins}
            hover={null}
            onpin={(x, y) => cmp.addPin(x, y)}
            accent={side === 'A' ? '#8fd3ff' : '#ffb454'}
          />
        </div>
      {/each}
    </div>

    {#if job.summary && !summaryStale(job)}
      {@const sum = job.summary}
      <div class="panel summary" data-testid="compare-summary">
        <strong>整体比较摘要</strong>
        <span>差异像素 <strong data-testid="summary-differ">{sum.pixel.differ}</strong> / {sum.pixel.total}</span>
        <span>平均差 {sum.pixel.meanAbs.toFixed(2)}</span>
        <span>最大差 {sum.pixel.maxAbs} @ ({sum.pixel.maxAt.x}, {sum.pixel.maxAt.y})</span>
        {#if sum.lab}
          <span>平均 ΔE00 {sum.lab.meanDE00.toFixed(2)}</span>
          <span>最大 ΔE00 <strong data-testid="summary-maxde">{sum.lab.maxDE00.toFixed(2)}</strong> @ ({sum.lab.maxAt.x}, {sum.lab.maxAt.y})</span>
        {/if}
        <span class="muted small">比较时间 {sum.computedAt}</span>
      </div>
    {:else if job.summary}
      <div class="panel small warn" data-testid="summary-stale">摘要已过期——条件已修改，两侧重新完成后会自动重算。</div>
    {/if}
  {/if}

  {#if c.jobs.length}
    <div class="panel stack">
      <h2>已保存的对比作业（IndexedDB）</h2>
      <div class="joblist scroll">
        {#each c.jobs as j (j.id)}
          <div class="row spread pl">
            <button class="ghost left" data-testid="open-job-{j.id}" onclick={() => cmp.openJob(j.id)} title="打开对比作业">
              <span>{j.name}{c.current?.id === j.id ? '（当前）' : ''}</span>
              <span class="small muted">{JOB_STATUS_LABEL[j.status]} · {new Date(j.updatedAt).toLocaleString()}</span>
            </button>
            <button class="ghost small danger" data-testid="delete-job-{j.id}" onclick={() => cmp.deleteJob(j.id)}>删</button>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .compare {
    min-height: 0;
    overflow-y: auto;
  }
  .jobbar {
    flex-wrap: wrap;
  }
  .jobname {
    flex: 1;
    min-width: 180px;
  }
  .sidecards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .sidecard {
    gap: 8px;
  }
  .params {
    gap: 10px;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .params .field {
    flex: 1;
    min-width: 120px;
  }
  .check {
    font-size: 12.5px;
    white-space: nowrap;
    padding-bottom: 8px;
  }
  .cmp-canvases {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    min-height: 260px;
  }
  .cmp-stage {
    display: flex;
    min-height: 0;
  }
  .summary {
    display: flex;
    gap: 16px;
    align-items: center;
    flex-wrap: wrap;
    font-size: 13px;
  }
  .joblist {
    max-height: 160px;
  }
  .pl {
    border-bottom: 1px solid #ffffff08;
    gap: 6px;
  }
  .left {
    text-align: left;
    display: flex;
    flex-direction: column;
    flex: 1;
  }
  .badge.job-draft { background: #4a4a5522; }
  .badge.job-running { background: #2b4a6b44; }
  .badge.job-partial { background: #7a5a2344; }
  .badge.job-complete { background: #2b6b3a44; }
  .badge.job-failed { background: #6b2b2b44; }
  .badge.side-running { background: #2b4a6b44; }
  .badge.side-done { background: #2b6b3a44; }
  .badge.side-stale { background: #7a5a2344; }
  .badge.side-failed { background: #6b2b2b44; }
</style>
