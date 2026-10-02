/**
 * 打样条件对比的作业状态（Svelte 5 runes）。
 *
 * 与主界面单条件转换完全隔离：
 *  - 建档时把原始像素、已确认源配置、两侧目标配置全部冻结进作业副本；
 *    之后主面板换图、换配置、换意图都不影响已建对比。
 *  - 两侧各自用 `冻结原图 + 冻结源配置` 直接调用 Worker 转换；一侧的结果
 *    永远不会成为另一侧的输入。
 *  - Worker 结果按 (作业 id, runVersion, 侧, 条件指纹) 归属：修改任一条件、
 *    取消、删除作业或重开工程后到达的旧结果一律丢弃，不会写入新对比。
 *  - 每次变更即持久化到 IndexedDB（comparisons 仓库），刷新/重载后可重新
 *    打开同一份对比快照。
 */
import { idbAll, idbDelete, idbPut, STORE_COMPARISONS, type StoredProfile } from '../db/db';
import { decodeImage } from '../codec/decode';
import { fnv1a64 } from '../color/hash';
import { runConvert, runSample, runSampleMulti, type ConvertedPayload } from '../workers/client';
import { downloadBytes } from '../codec/export';
import { newId, type AppState } from '../db/state.svelte';
import type { RenderingIntent } from '../color/lcms';
import type { EngineParams } from '../color/engine';
import {
  SIDE_KEYS,
  buildCompareRecord,
  deriveJobStatus,
  emptySideSpec,
  gridPoints,
  sideSpecHash,
  specComplete,
  summarizeSamples,
  type ComparePin,
  type CompareSideSpec,
  type SideKey,
  type StoredComparison,
} from './types';

function specFromProfile(
  p: StoredProfile,
  intent: RenderingIntent,
  blackPointCompensation: boolean,
  proofIntent: RenderingIntent,
): CompareSideSpec {
  const bytes = p.bytes.slice();
  return {
    targetProfileId: p.id,
    targetDescription: p.description,
    targetColorSpace: p.colorSpace,
    targetBytes: bytes,
    profileHash: fnv1a64(bytes),
    intent,
    blackPointCompensation,
    proofIntent,
  };
}

function paramsOf(spec: CompareSideSpec): EngineParams {
  return {
    intent: spec.intent,
    blackPointCompensation: spec.blackPointCompensation,
    proofIntent: spec.proofIntent,
  };
}

function createCompareState() {
  const state = $state({
    ready: false as boolean,
    jobs: [] as StoredComparison[],
    activeId: null as string | null,
    notice: '' as string,
  });

  const active = $derived(state.jobs.find((j) => j.id === state.activeId) ?? null);

  async function init() {
    try {
      state.jobs = await idbAll<StoredComparison>(STORE_COMPARISONS);
      // 上次会话可能中断在“运行中”：在途标记随页面关闭已失效，统一复位并落库。
      for (const j of state.jobs) {
        let interrupted = false;
        for (const k of SIDE_KEYS) {
          if (j.sides[k].runningVersion !== null) {
            j.sides[k].runningVersion = null;
            interrupted = true;
          }
        }
        const derived = deriveJobStatus(j);
        if (interrupted || derived !== j.status) {
          j.status = derived;
          await idbPut(STORE_COMPARISONS, $state.snapshot(j));
        }
      }
      sortJobs();
      state.ready = true;
    } catch (err) {
      state.notice = `对比作业载入失败：${err instanceof Error ? err.message : String(err)}`;
      state.ready = true;
    }
  }

  function sortJobs() {
    state.jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function jobById(id: string): StoredComparison | null {
    return state.jobs.find((j) => j.id === id) ?? null;
  }

  /** 重新派生状态并写入 IndexedDB（存快照副本，非响应式代理）。 */
  async function persist(job: StoredComparison) {
    job.updatedAt = new Date().toISOString();
    job.status = deriveJobStatus(job);
    await idbPut(STORE_COMPARISONS, $state.snapshot(job));
    sortJobs();
  }

  /**
   * 以当前“同一原始像素 + 同一已确认源配置”为起点建档。
   * 缺 ICC 且未确认源配置、或文件带转换标记时拒绝建档（两侧都不可启动）。
   */
  async function createFromCurrent(app: AppState): Promise<void> {
    const s = app.state;
    if (!s.image) {
      state.notice = '请先在「单条件转换」中导入图片。';
      return;
    }
    if (s.image.provenance.converted) {
      state.notice = '该文件带有转换标记，已是转换结果，不能作为对比原稿。';
      return;
    }
    if (!s.sourceProfile || (!s.image.embedded && !s.sourceAssumed)) {
      state.notice = '原图缺少嵌入 ICC 且尚未确认源配置——请先在「单条件转换」中选择源配置；未确认前两侧都不能启动。';
      return;
    }
    let width = s.image.width ?? 0;
    let height = s.image.height ?? 0;
    try {
      const d = await decodeImage(s.image.bytes);
      width = d.width;
      height = d.height;
    } catch {
      /* 尺寸仅用于展示与网格；解码失败不阻断建档 */
    }
    const now = new Date().toISOString();
    const src = s.sourceProfile;
    const mkSide = (): { spec: CompareSideSpec; runningVersion: null; result: null } => ({
      spec: s.targetProfile
        ? specFromProfile(s.targetProfile, s.intent, s.blackPointCompensation, s.proofIntent)
        : emptySideSpec(),
      runningVersion: null,
      result: null,
    });
    const job: StoredComparison = {
      id: newId('cmp'),
      name: `${s.image.name} · 条件对比`,
      createdAt: now,
      updatedAt: now,
      status: 'draft',
      runVersion: 0,
      image: {
        name: s.image.name,
        container: s.image.container,
        bitDepth: s.image.bitDepth,
        width,
        height,
        hash: fnv1a64(s.image.bytes),
        bytes: s.image.bytes.slice(),
      },
      source: {
        description: src.description,
        colorSpace: src.colorSpace,
        origin: s.image.embedded && !s.sourceAssumed ? 'embedded' : 'assumed',
        hash: fnv1a64(src.bytes),
        bytes: src.bytes.slice(),
      },
      sides: { A: mkSide(), B: mkSide() },
      pins: [],
      summary: null,
    };
    state.jobs.push(job);
    state.activeId = job.id;
    await persist(job);
    state.notice = `已建立对比作业「${job.name}」：原稿与源配置已冻结，主面板的后续改动不影响本作业。`;
  }

  function openJob(id: string) {
    if (jobById(id)) state.activeId = id;
  }

  async function deleteJob(id: string) {
    // 在途结果回收时按 id 找不到作业即被丢弃，不会写入别的对比。
    state.jobs = state.jobs.filter((j) => j.id !== id);
    if (state.activeId === id) state.activeId = null;
    await idbDelete(STORE_COMPARISONS, id);
  }

  /** 选择/更换一侧的目标配置：冻结新配置字节进该侧快照。 */
  async function setSideTarget(jobId: string, side: SideKey, profileId: string, profiles: StoredProfile[]) {
    const job = jobById(jobId);
    const p = profiles.find((x) => x.id === profileId);
    if (!job || !p) return;
    const old = job.sides[side].spec;
    job.sides[side].spec = specFromProfile(p, old.intent, old.blackPointCompensation, old.proofIntent);
    await persist(job);
  }

  /** 修改一侧的渲染意图 / 黑点补偿 / 软打样意图。 */
  async function setSideParams(
    jobId: string,
    side: SideKey,
    patch: Partial<Pick<CompareSideSpec, 'intent' | 'blackPointCompensation' | 'proofIntent'>>,
  ) {
    const job = jobById(jobId);
    if (!job) return;
    Object.assign(job.sides[side].spec, patch);
    await persist(job);
  }

  /**
   * 分派转换。onlySide 缺省时运行所有配置完整的侧。
   * 每侧独立从冻结原图直接计算；结果回收时校验版本与条件指纹。
   */
  async function run(jobId: string, onlySide?: SideKey) {
    const job = jobById(jobId);
    if (!job) return;
    const sides = (onlySide ? [onlySide] : SIDE_KEYS).filter((k) => specComplete(job.sides[k].spec));
    if (!sides.length) {
      state.notice = '两侧都还没有完整的目标配置，无法启动。';
      return;
    }
    job.runVersion++;
    const v = job.runVersion;
    // 同步捕获各侧分派参数（条件指纹 + 冻结字节 + 参数快照）。此后的异步
    // 空档里条件再被修改，也只影响回收校验，不会污染本次分派的内容。
    const dispatches = sides.map((k) => {
      const spec = job.sides[k].spec;
      job.sides[k].runningVersion = v;
      return {
        k,
        specHash: sideSpecHash(job, spec),
        targetIcc: spec.targetBytes,
        params: paramsOf(spec),
      };
    });
    await persist(job);
    for (const d of dispatches) {
      void runConvert({
        imageBytes: job.image.bytes,
        sourceIcc: job.source.bytes,
        targetIcc: d.targetIcc,
        params: d.params,
      }).then(
        (payload) => void settle(jobId, d.k, v, d.specHash, { ok: true, payload }),
        (err: unknown) =>
          void settle(jobId, d.k, v, d.specHash, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
      );
    }
  }

  type Outcome = { ok: true; payload: ConvertedPayload } | { ok: false; error: string };

  /** 回收 Worker 结果；任何归属校验失败都丢弃，不写入作业。 */
  async function settle(jobId: string, side: SideKey, v: number, specHash: string, outcome: Outcome) {
    const job = jobById(jobId);
    if (!job) return; // 作业已删除
    const s = job.sides[side];
    if (s.runningVersion !== v) return; // 已取消或被更新的分派取代
    s.runningVersion = null;
    if (job.runVersion !== v || sideSpecHash(job, s.spec) !== specHash) {
      // 分派后条件被修改 / 作业被取消重开：旧结果丢弃。
      await persist(job);
      return;
    }
    s.result = outcome.ok
      ? {
          status: 'done',
          runVersion: v,
          specHash,
          width: outcome.payload.width,
          height: outcome.payload.height,
          targetColorSpace: outcome.payload.targetColorSpace,
          softProofRGBA: outcome.payload.softProofRGBA,
          completedAt: new Date().toISOString(),
        }
      : {
          status: 'failed',
          runVersion: v,
          specHash,
          width: 0,
          height: 0,
          error: outcome.error,
          completedAt: new Date().toISOString(),
        };
    await persist(job);
    await refreshPinsForSide(jobId, side);
    await maybeAutoSummary(jobId);
  }

  /** 取消：递增版本使全部在途结果失效。 */
  async function cancel(jobId: string) {
    const job = jobById(jobId);
    if (!job) return;
    job.runVersion++;
    for (const k of SIDE_KEYS) job.sides[k].runningVersion = null;
    await persist(job);
  }

  /** 单独重试一侧（失败或过期后）。 */
  async function retrySide(jobId: string, side: SideKey) {
    await run(jobId, side);
  }

  async function addPin(jobId: string, x: number, y: number) {
    const job = jobById(jobId);
    if (!job) return;
    const pin: ComparePin = {
      id: newId('pin'),
      x,
      y,
      A: null,
      B: null,
      specHashA: '',
      specHashB: '',
    };
    job.pins.push(pin);
    await persist(job);
    for (const k of SIDE_KEYS) await samplePinSide(jobId, pin.id, k);
  }

  async function removePin(jobId: string, pinId: string) {
    const job = jobById(jobId);
    if (!job) return;
    job.pins = job.pins.filter((p) => p.id !== pinId);
    await persist(job);
  }

  /** 对单个取样点的某一侧取样；回收时同样校验作业、点与条件指纹。 */
  async function samplePinSide(jobId: string, pinId: string, side: SideKey) {
    const job = jobById(jobId);
    if (!job) return;
    const pin = job.pins.find((p) => p.id === pinId);
    if (!pin) return;
    const spec = job.sides[side].spec;
    if (!specComplete(spec)) return;
    const h = sideSpecHash(job, spec);
    try {
      const info = await runSample({
        imageBytes: job.image.bytes,
        sourceIcc: job.source.bytes,
        targetIcc: spec.targetBytes,
        params: paramsOf(spec),
        x: pin.x,
        y: pin.y,
      });
      const j2 = jobById(jobId);
      const p2 = j2?.pins.find((p) => p.id === pinId);
      if (!j2 || !p2) return;
      if (sideSpecHash(j2, j2.sides[side].spec) !== h) return; // 条件已改，旧取样丢弃
      p2[side] = info;
      p2[side === 'A' ? 'specHashA' : 'specHashB'] = h;
      delete p2[side === 'A' ? 'errorA' : 'errorB'];
      await persist(j2);
    } catch (err) {
      const j2 = jobById(jobId);
      const p2 = j2?.pins.find((p) => p.id === pinId);
      if (!j2 || !p2) return;
      p2[side === 'A' ? 'errorA' : 'errorB'] = err instanceof Error ? err.message : String(err);
      await persist(j2);
    }
  }

  /** 一侧落定后，刷新该侧所有已过期的取样读数。 */
  async function refreshPinsForSide(jobId: string, side: SideKey) {
    const job = jobById(jobId);
    if (!job) return;
    const spec = job.sides[side].spec;
    if (!specComplete(spec)) return;
    const h = sideSpecHash(job, spec);
    for (const pin of [...job.pins]) {
      const key = side === 'A' ? 'specHashA' : 'specHashB';
      if (pin[key] === h && pin[side]) continue;
      await samplePinSide(jobId, pin.id, side);
    }
  }

  /** 两侧都以当前条件完成后自动（重）算整体摘要。 */
  async function maybeAutoSummary(jobId: string) {
    const job = jobById(jobId);
    if (!job) return;
    const hA = sideSpecHash(job, job.sides.A.spec);
    const hB = sideSpecHash(job, job.sides.B.spec);
    const doneA = job.sides.A.result?.status === 'done' && job.sides.A.result.specHash === hA;
    const doneB = job.sides.B.result?.status === 'done' && job.sides.B.result.specHash === hB;
    if (!doneA || !doneB) return;
    if (job.summary && job.summary.specHashA === hA && job.summary.specHashB === hB) return;
    await computeSummary(jobId);
  }

  /** 网格取样两侧目标 Lab，计算 ΔE2000 整体摘要。 */
  async function computeSummary(jobId: string) {
    const job = jobById(jobId);
    if (!job) return;
    if (!specComplete(job.sides.A.spec) || !specComplete(job.sides.B.spec)) return;
    const hA = sideSpecHash(job, job.sides.A.spec);
    const hB = sideSpecHash(job, job.sides.B.spec);
    const pts = gridPoints(job.image.width || 1, job.image.height || 1, 5);
    try {
      const [infosA, infosB] = await Promise.all([
        runSampleMulti({
          imageBytes: job.image.bytes,
          sourceIcc: job.source.bytes,
          targetIcc: job.sides.A.spec.targetBytes,
          params: paramsOf(job.sides.A.spec),
          points: pts,
        }),
        runSampleMulti({
          imageBytes: job.image.bytes,
          sourceIcc: job.source.bytes,
          targetIcc: job.sides.B.spec.targetBytes,
          params: paramsOf(job.sides.B.spec),
          points: pts,
        }),
      ]);
      const j2 = jobById(jobId);
      if (!j2) return;
      // 计算期间条件被修改则丢弃，不写回旧摘要。
      if (sideSpecHash(j2, j2.sides.A.spec) !== hA || sideSpecHash(j2, j2.sides.B.spec) !== hB) return;
      j2.summary = summarizeSamples(pts, infosA, infosB, hA, hB, new Date().toISOString());
      await persist(j2);
    } catch (err) {
      state.notice = `对比摘要计算失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** 导出对比记录 JSON：含两侧配置指纹与比较时间。 */
  function exportRecord(jobId: string) {
    const job = jobById(jobId);
    if (!job) return;
    const rec = buildCompareRecord(job);
    const bytes = new TextEncoder().encode(JSON.stringify(rec, null, 2));
    const base = job.name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'compare';
    downloadBytes(`${base}.compare-record.json`, bytes, 'application/json');
    state.notice = '已导出对比记录（含两侧配置指纹与比较时间）。';
  }

  return {
    state,
    get active() {
      return active;
    },
    init,
    createFromCurrent,
    openJob,
    deleteJob,
    setSideTarget,
    setSideParams,
    run,
    cancel,
    retrySide,
    addPin,
    removePin,
    computeSummary,
    exportRecord,
  };
}

export type CompareState = ReturnType<typeof createCompareState>;

let singleton: CompareState | null = null;
export function getCompare(): CompareState {
  singleton ??= createCompareState();
  return singleton;
}
