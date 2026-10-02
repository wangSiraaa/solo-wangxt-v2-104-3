<script lang="ts">
  import type { AppState } from '../db/state.svelte';
  import type { CompareState } from '../compare/compare.svelte';
  import { INTENT_LABEL, type RenderingIntent } from '../color/lcms';
  import {
    JOB_STATUS_LABEL,
    SIDE_STATUS_LABEL,
    SIDE_KEYS,
    sideDisplayStatus,
    sideSpecHash,
    specComplete,
    type SideKey,
  } from '../compare/types';

  let { app, cmp }: { app: AppState; cmp: CompareState } = $props();
  const s = app.state;
  const c = cmp.state;
  const job = $derived(cmp.active);

  const intents: RenderingIntent[] = [
    'perceptual',
    'relative-colorimetric',
    'saturation',
    'absolute-colorimetric',
  ];

  // 建档门槛：必须有原图 + 已确认源配置（嵌入或人工假设），且不带转换标记。
  const gateReason = $derived(
    !s.image
      ? '请先在「单条件转换」中导入图片。'
      : s.image.provenance.converted
        ? '该文件带有转换标记，已是转换结果，不能作为对比原稿。'
        : !s.image.embedded && !s.sourceAssumed
          ? '原图缺少嵌入 ICC 且尚未确认源配置——请先在「单条件转换」中选择源配置；未确认前两侧都不能启动。'
          : '',
  );
  const canCreate = $derived(gateReason === '');

  const anyRunning = $derived(job ? job.status === 'running' : false);
  const anyComplete = $derived(job ? SIDE_KEYS.some((k) => specComplete(job.sides[k].spec)) : false);

  let profileInput = $state<HTMLInputElement | null>(null);

  function sideStatusLabel(k: SideKey): string {
    if (!job) return '';
    return SIDE_STATUS_LABEL[sideDisplayStatus(job, k)];
  }
</script>

<div class="stack">
  <div class="panel stack">
    <h2>打样条件对比（同一原稿 · 两套条件）</h2>
    <div class="small muted">
      以当前原稿与已确认源配置为起点建档，冻结字节后两套条件各自独立计算；任何一侧的结果都不会作为另一侧的输入。
    </div>
    <button class="primary create-btn" disabled={!canCreate} onclick={() => cmp.createFromCurrent(app)}>
      从当前原稿与已确认源配置新建对比
    </button>
    {#if !canCreate}
      <div class="warn small gate-hint">{gateReason}</div>
    {/if}
    {#if c.notice}
      <button class="small muted notice" onclick={() => (c.notice = '')}>{c.notice}（点击关闭）</button>
    {/if}
  </div>

  <div class="panel stack">
    <h2>对比作业（IndexedDB，更改即保存）</h2>
    {#if c.jobs.length === 0}
      <div class="small muted">尚无对比作业。作业冻结原稿与条件快照，刷新/重载后仍可打开。</div>
    {:else}
      <div class="joblist scroll">
        {#each c.jobs as j (j.id)}
          <div class="row spread pl job-item" class:open={j.id === c.activeId}>
            <button class="ghost left" onclick={() => cmp.openJob(j.id)} title="打开对比快照">
              <span>{j.name}</span>
              <span class="small muted">
                <span class="badge status-{j.status}">{JOB_STATUS_LABEL[j.status]}</span>
                {new Date(j.updatedAt).toLocaleString()}
              </span>
            </button>
            <button class="ghost small danger" onclick={() => cmp.deleteJob(j.id)}>删</button>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#if job}
    <div class="panel stack job-head">
      <h2>当前对比 · <span class="badge status-{job.status} job-status">{JOB_STATUS_LABEL[job.status]}</span></h2>
      <div class="small stack">
        <div>
          原稿 <strong>{job.image.name}</strong>
          <span class="muted mono">{job.image.width}×{job.image.height} · 哈希 {job.image.hash.slice(0, 8)}…</span>
        </div>
        <div>
          源配置
          <span class="badge" class:embedded={job.source.origin === 'embedded'} class:assumed={job.source.origin === 'assumed'}>
            {job.source.origin === 'embedded' ? '嵌入 ICC' : '人工假设'}
          </span>
          <span class="mono">{job.source.description}</span>
          <span class="muted mono">指纹 {job.source.hash.slice(0, 8)}…</span>
        </div>
        <div class="muted">已冻结：本作业不随主面板的图片/配置/意图选择变化。</div>
      </div>
      <div class="row">
        <button class="primary run-btn" disabled={!anyComplete || anyRunning} onclick={() => cmp.run(job.id)}>
          {anyRunning ? 'LittleCMS 转换中…' : '运行对比（两侧各自从原图计算）'}
        </button>
        {#if anyRunning}
          <button class="cancel-btn" onclick={() => cmp.cancel(job.id)}>取消</button>
        {/if}
      </div>
      <button class="export-btn" disabled={!job.sides.A.result && !job.sides.B.result} onclick={() => cmp.exportRecord(job.id)}>
        导出对比记录（含两侧配置指纹与比较时间）
      </button>
    </div>

    {#each SIDE_KEYS as k (k)}
      {@const side = job.sides[k]}
      {@const st = sideDisplayStatus(job, k)}
      <div class="panel stack cmp-editor-{k} side-editor">
        <div class="row spread">
          <h2>条件 {k}</h2>
          <span class="badge side-status status-{st}">{sideStatusLabel(k)}</span>
        </div>

        <label class="field">
          目标 ICC 配置
          <select
            class="target-select"
            value={side.spec.targetProfileId}
            onchange={(e) => cmp.setSideTarget(job.id, k, (e.currentTarget as HTMLSelectElement).value, s.profiles)}
          >
            <option value="" disabled>-- 请选择目标配置 --</option>
            {#each s.profiles as p (p.id)}
              <option value={p.id}>{p.description} [{p.colorSpace}]</option>
            {/each}
            {#if side.spec.targetProfileId && !s.profiles.some((p) => p.id === side.spec.targetProfileId)}
              <option value={side.spec.targetProfileId}>{side.spec.targetDescription}（库中已删除，使用冻结副本）</option>
            {/if}
          </select>
        </label>
        {#if specComplete(side.spec)}
          <div class="muted small mono">
            {side.spec.targetColorSpace} · 配置指纹 {side.spec.profileHash.slice(0, 8)}… · 条件指纹 {sideSpecHash(job, side.spec).slice(0, 8)}…
          </div>
        {/if}

        <label class="field">
          渲染意图
          <select
            class="intent-select"
            value={side.spec.intent}
            onchange={(e) => cmp.setSideParams(job.id, k, { intent: (e.currentTarget as HTMLSelectElement).value as RenderingIntent })}
          >
            {#each intents as i}
              <option value={i}>{INTENT_LABEL[i]}</option>
            {/each}
          </select>
        </label>

        <label class="row check">
          <input
            type="checkbox"
            class="bpc-check"
            checked={side.spec.blackPointCompensation}
            onchange={(e) => cmp.setSideParams(job.id, k, { blackPointCompensation: (e.currentTarget as HTMLInputElement).checked })}
          />
          <span>黑点补偿（BPC）</span>
        </label>

        <label class="field">
          软打样模拟意图（目标→显示器）
          <select
            class="proof-select"
            value={side.spec.proofIntent}
            onchange={(e) => cmp.setSideParams(job.id, k, { proofIntent: (e.currentTarget as HTMLSelectElement).value as RenderingIntent })}
          >
            <option value="relative-colorimetric">相对色度（标准软打样）</option>
            <option value="absolute-colorimetric">绝对色度（模拟纸白）</option>
            <option value="perceptual">感知式</option>
            <option value="saturation">饱和度</option>
          </select>
        </label>

        {#if side.result?.status === 'failed'}
          <div class="danger small fail-box">
            失败证据：{side.result.error}
            {#if st === 'stale'}<span class="muted">（该失败属于旧条件）</span>{/if}
          </div>
        {/if}
        {#if st === 'stale'}
          <div class="warn small">条件已修改，现有结果为旧条件快照（已过期），需重新运行。</div>
        {/if}
        {#if side.result?.status === 'done'}
          <div class="muted small">完成于 {new Date(side.result.completedAt).toLocaleString()}</div>
        {/if}

        <button
          class="run-side-btn"
          disabled={!specComplete(side.spec) || st === 'running'}
          onclick={() => cmp.retrySide(job.id, k)}
        >
          {st === 'running' ? '转换中…' : `仅运行 / 重试 ${k} 侧`}
        </button>
      </div>
    {/each}
  {/if}

  <div class="panel stack">
    <h2>ICC 配置库（供两侧选择）</h2>
    <input
      type="file"
      accept=".icc,.icm"
      multiple
      bind:this={profileInput}
      onchange={(e) => {
        const fs = (e.currentTarget as HTMLInputElement).files;
        if (fs) app.importProfiles(fs);
      }}
    />
    <div class="muted small">导入后即冻结进所选侧的条件快照；之后从库中删除也不影响已建作业。</div>
  </div>
</div>

<style>
  .joblist {
    max-height: 180px;
  }
  .pl {
    border-bottom: 1px solid #ffffff08;
    gap: 6px;
  }
  .pl.open {
    outline: 1px solid var(--accent);
    border-radius: 6px;
  }
  .left {
    text-align: left;
    display: flex;
    flex-direction: column;
    flex: 1;
    gap: 2px;
  }
  .side-editor h2 {
    margin: 0;
  }
  .check {
    font-size: 13px;
  }
  .notice {
    text-align: left;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }
  .fail-box {
    border: 1px solid #6b2f2f;
    background: #3a202055;
    border-radius: 6px;
    padding: 6px 8px;
    word-break: break-all;
  }
  .status-draft { color: var(--muted); }
  .status-running { color: var(--accent); border-color: var(--accent); }
  .status-partial { color: var(--warn); border-color: #7a5a23; }
  .status-done { color: var(--accent-2); border-color: #2f6b4c; }
  .status-failed { color: var(--danger); border-color: #6b2f2f; }
  .status-stale { color: var(--warn); border-color: #7a5a23; }
  .status-pending { color: var(--muted); }
  .status-empty { color: var(--muted); }
</style>
