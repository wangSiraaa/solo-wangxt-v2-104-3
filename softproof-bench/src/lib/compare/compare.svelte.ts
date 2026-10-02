/**
 * 打样条件对比 store（Svelte 5 runes）。
 *
 * 一份对比作业 = 同一份冻结的原始像素 + 同一份冻结的已确认源配置 +
 * 两套彼此独立的侧条件快照（目标配置 / 渲染意图 / 黑点补偿 / 软打样意图）。
 *
 * 纪律：
 *  - 两侧都直接从 job.image.bytes（原始像素）计算，任何一侧的结果都不会
 *    成为另一侧的输入；
 *  - 每次运行签发 runToken（作业版本），Worker 返回按 (jobId, runToken)
 *    归属；修改条件、取消、删除或重开作业都会使旧 token 失效，迟到的
 *    结果被丢弃，绝不写入新对比；
 *  - 作业整体持久化到 IndexedDB（含两侧结果与取样钉），刷新/重开后仍指向
 *    原始图片与冻结条件，与主面板当前选择无关。
 */
import { idbAll, idbDelete, idbGet, idbPut, STORE_COMPARE, type StoredProfile } from '../db/db';
import { runCompareSide, runCompareSamples, CompareWorkerError } from '../workers/client';
import { downloadBytes } from '../codec/export';
import { fnv1a64 } from '../color/hash';
import type { AppState } from '../db/state.svelte';
import type { RenderingIntent } from '../color/lcms';
import {
  SIDE_IDS,
  deriveJobStatus,
  effectiveSideStatus,
  emptySide,
  gridPoints,
  computePixelSummary,
  summarizeGrid,
  makeSideConfig,
  newCompareId,
  refreshSideFingerprint,
  shouldAcceptResult,
  summaryStale,
  buildCompareRecord,
  type CompareJobMeta,
  type ComparePin,
  type SideId,
  type StoredCompareJob,
} from './model';

const APP_VERSION = '0.1.0';

function createCompareStore() {
  const state = $state({
    ready: false as boolean,
    jobs: [] as CompareJobMeta[],
    current: null as StoredCompareJob | null,
    notice: '' as string,
  });

  /** 会话内作业对象缓存：保证在途运行写回的仍是同一对象。 */
  const cache = new Map<string, StoredCompareJob>();
  /** 本会话中已删除的作业 id：在途结果不得再落盘。 */
  const deleted = new Set<string>();
  /** 摘要计算在途的作业 id：避免两侧同时完成时重复计算。 */
  const summarizing = new Set<string>();

  async function init() {
    const all = await idbAll<StoredCompareJob>(STORE_COMPARE);
    // 上次会话可能中断在“运行中”：页面重开后没有对应 worker 运行，复位为未运行。
    for (const job of all) {
      let dirty = false;
      for (const id of SIDE_IDS) {
        if (job.sides[id].running) {
          job.sides[id].running = false;
          dirty = true;
        }
      }
      if (dirty) {
        job.status = deriveJobStatus(job);
        await idbPut(STORE_COMPARE, job);
      }
    }
    state.jobs = metasOf(all);
    state.ready = true;
  }

  function metasOf(all: StoredCompareJob[]): CompareJobMeta[] {
    return all
      .map((j) => ({ id: j.id, name: j.name, updatedAt: j.updatedAt, status: deriveJobStatus(j) }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** 能否以当前主面板状态建立对比作业（缺 ICC 且未确认源配置时两侧均不可启动）。 */
  function canCreateFrom(app: AppState): { ok: boolean; reason: string } {
    const s = app.state;
    if (!s.image) return { ok: false, reason: '尚未导入原图——请先在左侧导入图片。' };
    if (s.image.provenance.converted)
      return { ok: false, reason: '当前文件带有本工具的转换标记，不能当作原稿建立对比。' };
    if (!s.image.embedded && !s.sourceAssumed)
      return {
        ok: false,
        reason: '原图缺少嵌入 ICC 且尚未确认源配置——请先在左侧“源色彩空间”中指定；未确认前两侧均不可启动。',
      };
    if (!s.sourceProfile) return { ok: false, reason: '尚未确认源配置。' };
    return { ok: true, reason: '' };
  }

  /** 以当前原稿 + 已确认源配置为起点建立对比作业（全部冻结为独立副本）。 */
  async function newFromCurrent(app: AppState): Promise<boolean> {
    const chk = canCreateFrom(app);
    if (!chk.ok) {
      state.notice = chk.reason;
      return false;
    }
    const s = app.state;
    const img = s.image!;
    const srcProfile = s.sourceProfile!;
    const now = new Date().toISOString();
    const imageBytes = img.bytes.slice();
    const sourceBytes = srcProfile.bytes.slice();
    const job: StoredCompareJob = {
      id: newCompareId('cmp'),
      name: `对比 ${img.name}`,
      createdAt: now,
      updatedAt: now,
      status: 'draft',
      image: {
        bytes: imageBytes,
        name: img.name,
        hash: fnv1a64(imageBytes),
        container: img.container,
        bitDepth: img.bitDepth,
      },
      source: {
        profileBytes: sourceBytes,
        description: srcProfile.description,
        fingerprint: fnv1a64(sourceBytes),
        colorSpace: srcProfile.colorSpace,
        origin: img.embedded && !s.sourceAssumed ? 'embedded' : 'assumed',
        assumptionNote: s.sourceAssumed
          ? '原图缺少嵌入配置，操作员手动选择源配置；该假设已随对比作业冻结记录。'
          : undefined,
      },
      sides: { A: emptySide(), B: emptySide() },
      summary: null,
      summaryToken: '',
      pins: [],
    };
    // 侧 A 默认取当前面板的目标条件（冻结快照）；侧 B 留空由操作员选择。
    if (s.targetProfile) {
      job.sides.A.config = makeSideConfig(s.targetProfile, {
        intent: s.intent,
        blackPointCompensation: s.blackPointCompensation,
        proofIntent: s.proofIntent,
      });
    }
    cache.set(job.id, job);
    state.current = job;
    await persist(job);
    state.notice = `已建立对比作业：${job.name}（原稿与源配置已冻结）`;
    return true;
  }

  async function openJob(id: string) {
    let job = cache.get(id);
    if (!job) {
      const raw = await idbGet<StoredCompareJob>(STORE_COMPARE, id);
      if (!raw) return;
      for (const sideId of SIDE_IDS) raw.sides[sideId].running = false;
      job = raw;
      cache.set(id, job);
    }
    state.current = job;
  }

  function closeJob() {
    state.current = null;
  }

  async function deleteJob(id: string) {
    deleted.add(id); // 在途结果因 token/删除标记被丢弃
    const job = cache.get(id);
    if (job) {
      for (const sideId of SIDE_IDS) {
        job.sides[sideId].runToken = newCompareId('run');
        job.sides[sideId].running = false;
      }
    }
    cache.delete(id);
    await idbDelete(STORE_COMPARE, id);
    if (state.current?.id === id) state.current = null;
    state.jobs = state.jobs.filter((j) => j.id !== id);
  }

  async function renameJob(name: string) {
    const job = state.current;
    if (!job) return;
    job.name = name;
    await persist(job);
  }

  /** 更换一侧的目标配置：建立新的冻结快照，并使该侧在途/既有结果失效。 */
  async function setSideProfile(side: SideId, profile: StoredProfile) {
    const job = state.current;
    if (!job) return;
    const s = job.sides[side];
    const prev = s.config;
    s.config = makeSideConfig(profile, {
      intent: prev?.intent ?? 'relative-colorimetric',
      blackPointCompensation: prev?.blackPointCompensation ?? true,
      proofIntent: prev?.proofIntent ?? 'relative-colorimetric',
    });
    bumpRun(job, s);
    await persist(job);
  }

  /** 修改一侧的转换参数（意图 / BPC / 软打样意图）：重算指纹并使旧结果过期。 */
  async function setSideParams(
    side: SideId,
    patch: Partial<{ intent: RenderingIntent; blackPointCompensation: boolean; proofIntent: RenderingIntent }>,
  ) {
    const job = state.current;
    if (!job) return;
    const s = job.sides[side];
    if (!s.config) return;
    Object.assign(s.config, patch);
    refreshSideFingerprint(s.config);
    bumpRun(job, s);
    await persist(job);
  }

  /** 使该侧在途运行与在途摘要失效（修改条件/取消时调用）。 */
  function bumpRun(job: StoredCompareJob, s: StoredCompareJob['sides'][SideId]) {
    s.runToken = newCompareId('run');
    s.running = false;
    job.summaryToken = newCompareId('sum');
  }

  /** 运行一侧：从冻结的原始像素直接计算。 */
  async function runSide(side: SideId) {
    const job = state.current;
    if (!job) return;
    const s = job.sides[side];
    if (!s.config || s.running) return;
    const cfg = s.config;
    const runToken = newCompareId('run');
    s.runToken = runToken;
    s.running = true;
    s.error = null;
    s.failedAt = null;
    await persist(job);
    try {
      const res = await runCompareSide({
        attribution: { jobId: job.id, runToken, side },
        imageBytes: job.image.bytes,
        sourceIcc: job.source.profileBytes,
        targetIcc: cfg.profileBytes,
        params: {
          intent: cfg.intent,
          blackPointCompensation: cfg.blackPointCompensation,
          proofIntent: cfg.proofIntent,
        },
      });
      // 归属校验：协议回显 + 作业当前版本，双重确认才允许写入。
      if (deleted.has(job.id)) return;
      if (res.attribution.jobId !== job.id || res.attribution.runToken !== runToken) return;
      if (!shouldAcceptResult(s, runToken)) return;
      s.result = {
        softProofRGBA: res.payload.softProofRGBA,
        width: res.payload.width,
        height: res.payload.height,
        targetColorSpace: res.payload.targetColorSpace,
        completedAt: new Date().toISOString(),
        configFingerprint: cfg.fingerprint,
        runToken,
      };
      s.running = false;
      s.error = null;
      await persist(job);
      void maybeSummarize(job);
    } catch (err) {
      if (deleted.has(job.id)) return;
      if (err instanceof CompareWorkerError && err.attribution && err.attribution.runToken !== runToken) return;
      if (!shouldAcceptResult(s, runToken)) return; // 条件已改/已取消：迟到失败同样丢弃
      s.running = false;
      s.error = err instanceof Error ? err.message : String(err);
      s.failedAt = new Date().toISOString();
      await persist(job);
    }
  }

  /** 运行所有“结果不当前”的侧（已完成的侧保留不重跑）。 */
  async function runAll() {
    const job = state.current;
    if (!job) return;
    const need = SIDE_IDS.filter((id) => {
      const s = job.sides[id];
      return s.config && !s.running && effectiveSideStatus(s) !== 'done';
    });
    await Promise.all(need.map((id) => runSide(id)));
  }

  /** 取消：在途运行作废，迟到结果由 token 校验丢弃。 */
  async function cancel() {
    const job = state.current;
    if (!job) return;
    for (const id of SIDE_IDS) {
      const s = job.sides[id];
      if (s.running) bumpRun(job, s);
    }
    job.summaryToken = newCompareId('sum');
    await persist(job);
  }

  /** 两侧都完成且摘要过期时自动重算整体摘要。 */
  async function maybeSummarize(job: StoredCompareJob) {
    if (effectiveSideStatus(job.sides.A) !== 'done' || effectiveSideStatus(job.sides.B) !== 'done') return;
    if (!summaryStale(job)) return;
    if (summarizing.has(job.id)) return;
    summarizing.add(job.id);
    try {
      await computeSummary(job);
    } finally {
      summarizing.delete(job.id);
    }
  }

  /** 整体比较摘要：逐像素差异 + 网格取样的双侧 ΔE00。 */
  async function computeSummary(job: StoredCompareJob) {
    const A = job.sides.A;
    const B = job.sides.B;
    if (!A.config || !B.config || !A.result || !B.result) return;
    const token = newCompareId('sum');
    job.summaryToken = token;
    const pixel = computePixelSummary(A.result.softProofRGBA, B.result.softProofRGBA, A.result.width, A.result.height);
    const points = gridPoints(A.result.width, A.result.height, 8);
    let lab = null as ReturnType<typeof summarizeGrid>;
    try {
      const res = await runCompareSamples({
        attribution: { jobId: job.id, runToken: token },
        imageBytes: job.image.bytes,
        sourceIcc: job.source.profileBytes,
        sideA: { targetIcc: A.config.profileBytes, params: paramsOf(A.config) },
        sideB: { targetIcc: B.config.profileBytes, params: paramsOf(B.config) },
        points,
      });
      if (deleted.has(job.id) || job.summaryToken !== token) return;
      lab = summarizeGrid(res.samples);
    } catch {
      if (deleted.has(job.id) || job.summaryToken !== token) return;
      lab = null; // 摘要的 ΔE 部分失败时仍保留像素差异部分
    }
    job.summary = {
      computedAt: new Date().toISOString(),
      aFingerprint: A.config.fingerprint,
      bFingerprint: B.config.fingerprint,
      pixel,
      lab,
    };
    await persist(job);
  }

  function paramsOf(cfg: NonNullable<StoredCompareJob['sides'][SideId]['config']>) {
    return { intent: cfg.intent, blackPointCompensation: cfg.blackPointCompensation, proofIntent: cfg.proofIntent };
  }

  /** 钉选取样点：两侧各自从原图直接取样（可定位的取样差异证据）。 */
  async function addPin(x: number, y: number) {
    const job = state.current;
    if (!job) return;
    const A = job.sides.A;
    const B = job.sides.B;
    if (!A.config || !B.config) {
      state.notice = '请先为 A、B 两侧都选择目标配置，再钉选取样点。';
      return;
    }
    const pin: ComparePin = {
      x,
      y,
      a: null,
      b: null,
      aFingerprint: null,
      bFingerprint: null,
      pending: true,
    };
    job.pins.push(pin);
    // 之后必须通过代理对象修改，直接改原始对象不会触发界面更新。
    const px = job.pins[job.pins.length - 1];
    // 记录采样时刻的条件指纹：之后条件再变，该钉会被标记为过期。
    const aFp = A.config.fingerprint;
    const bFp = B.config.fingerprint;
    try {
      const res = await runCompareSamples({
        attribution: { jobId: job.id, runToken: newCompareId('pin') },
        imageBytes: job.image.bytes,
        sourceIcc: job.source.profileBytes,
        sideA: { targetIcc: A.config.profileBytes, params: paramsOf(A.config) },
        sideB: { targetIcc: B.config.profileBytes, params: paramsOf(B.config) },
        points: [{ x, y }],
      });
      if (deleted.has(job.id)) return;
      const s0 = res.samples[0];
      px.a = s0?.a ?? null;
      px.b = s0?.b ?? null;
      px.aError = s0?.aError;
      px.bError = s0?.bError;
      px.aFingerprint = aFp;
      px.bFingerprint = bFp;
      px.pending = false;
      await persist(job);
    } catch (err) {
      if (deleted.has(job.id)) return;
      px.pending = false;
      px.aError = px.bError = err instanceof Error ? err.message : String(err);
      await persist(job);
    }
  }

  async function removePin(i: number) {
    const job = state.current;
    if (!job) return;
    job.pins.splice(i, 1);
    await persist(job);
  }

  /** 导出对比记录 JSON：含两侧条件指纹与比较时间。 */
  function exportRecord() {
    const job = state.current;
    if (!job) return;
    const record = buildCompareRecord(job, new Date().toISOString(), APP_VERSION);
    const bytes = new TextEncoder().encode(JSON.stringify(record, null, 2));
    const base = job.name.replace(/[^\w一-龥-]+/g, '_').slice(0, 60) || 'compare';
    downloadBytes(`${base}.compare-record.json`, bytes, 'application/json');
    state.notice = '已导出对比记录（含两侧条件指纹与比较时间）。';
  }

  /** 持久化当前版本的作业（快照写入，刷新/重开后仍指向冻结条件）。 */
  async function persist(job: StoredCompareJob) {
    if (deleted.has(job.id)) return;
    job.updatedAt = new Date().toISOString();
    job.status = deriveJobStatus(job);
    const snap = $state.snapshot(job) as StoredCompareJob;
    await idbPut(STORE_COMPARE, snap);
    const meta: CompareJobMeta = { id: job.id, name: job.name, updatedAt: job.updatedAt, status: job.status };
    state.jobs = [meta, ...state.jobs.filter((j) => j.id !== job.id)].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  return {
    state,
    init,
    canCreateFrom,
    newFromCurrent,
    openJob,
    closeJob,
    deleteJob,
    renameJob,
    setSideProfile,
    setSideParams,
    runSide,
    runAll,
    cancel,
    recomputeSummary: () => (state.current ? computeSummary(state.current) : Promise.resolve()),
    addPin,
    removePin,
    exportRecord,
  };
}

export type CompareStore = ReturnType<typeof createCompareStore>;

let singleton: CompareStore | null = null;
export function getCompare(): CompareStore {
  singleton ??= createCompareStore();
  return singleton;
}
