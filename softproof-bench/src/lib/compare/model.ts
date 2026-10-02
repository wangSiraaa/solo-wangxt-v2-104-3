/**
 * 打样条件对比（proofing condition comparison）— 纯模型逻辑。
 *
 * 本模块不触碰任何浏览器 API，可在 Node 中单测；Svelte store、Worker 与
 * 客户端共同遵守这里的约定：
 *
 *  - 一份对比作业冻结同一份原始像素与同一份“已确认”源配置（嵌入或人工假设），
 *    之后主面板的任何选择变化都不影响该作业；
 *  - A/B 两侧各自持有独立的目标配置 + 渲染意图 + 黑点补偿 + 软打样意图快照，
 *    条件指纹（fingerprint）覆盖配置字节与全部参数；
 *  - 每次运行签发 runToken（作业版本）。Worker 返回按 (jobId, runToken) 归属：
 *    修改任一条件、取消或重开作业都会使旧 token 失效，迟到的结果一律丢弃，
 *    绝不写入新对比；
 *  - 两侧都直接从原始像素计算，任何一侧的转换结果都不会成为另一侧的输入。
 */
import { fnv1a64 } from '../color/hash';
import { deltaE2000, fromTriple } from '../color/colorMath';
import { DISCLAIMER } from '../color/record';
import type { RenderingIntent } from '../color/lcms';
import type { SampleInfo } from '../color/engine';
import type { ColorSpaceKind } from '../icc/profileInfo';

export const COMPARE_RECORD_FORMAT = 'softproof-bench-compare/1';

export type SideId = 'A' | 'B';
export const SIDE_IDS: SideId[] = ['A', 'B'];

export type SideStatus = 'idle' | 'running' | 'done' | 'stale' | 'failed';
export type CompareJobStatus = 'draft' | 'running' | 'partial' | 'complete' | 'failed';

export const SIDE_STATUS_LABEL: Record<SideStatus, string> = {
  idle: '待运行',
  running: '运行中',
  done: '已完成',
  stale: '已过期',
  failed: '失败',
};

export const JOB_STATUS_LABEL: Record<CompareJobStatus, string> = {
  draft: '草稿',
  running: '运行中',
  partial: '部分完成',
  complete: '完成',
  failed: '失败',
};

/** ICC 渲染意图码（与 lcms INTENT_* 常量一致），纯模型不依赖 WASM 模块。 */
export const INTENT_CODE: Record<RenderingIntent, number> = {
  perceptual: 0,
  'relative-colorimetric': 1,
  saturation: 2,
  'absolute-colorimetric': 3,
};

let uid = 1;
/** Session-unique id / token generator (job ids, run tokens, summary tokens). */
export const newCompareId = (p = 'cmp'): string =>
  `${p}-${Date.now().toString(36)}-${(uid++).toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;

/** 一侧的冻结条件快照：目标配置字节 + 全部转换参数。 */
export interface CompareSideConfig {
  targetProfileId: string;
  description: string;
  colorSpace: ColorSpaceKind;
  /** 冻结的配置字节副本——不随配置库增删或面板选择变化。 */
  profileBytes: Uint8Array;
  /** 仅配置字节的指纹。 */
  profileFingerprint: string;
  intent: RenderingIntent;
  blackPointCompensation: boolean;
  proofIntent: RenderingIntent;
  /** 条件指纹：覆盖配置字节 + 渲染意图 + BPC + 软打样意图。 */
  fingerprint: string;
}

export interface CompareSideResult {
  softProofRGBA: Uint8Array;
  width: number;
  height: number;
  targetColorSpace: ColorSpaceKind;
  completedAt: string;
  /** 产生该结果时的条件指纹；与当前条件指纹不一致即“已过期”。 */
  configFingerprint: string;
  /** 产生该结果的作业版本令牌。 */
  runToken: string;
}

export interface CompareSide {
  config: CompareSideConfig | null;
  running: boolean;
  runToken: string;
  result: CompareSideResult | null;
  /** 失败证据：保留到下一次运行启动。 */
  error: string | null;
  failedAt: string | null;
}

export interface ComparePin {
  x: number;
  y: number;
  a: SampleInfo | null;
  b: SampleInfo | null;
  /** 采样时两侧各自的条件指纹；与当前条件不一致即“已过期”。 */
  aFingerprint: string | null;
  bFingerprint: string | null;
  aError?: string;
  bError?: string;
  pending: boolean;
}

export interface PixelSummary {
  total: number;
  /** RGB 任一通道绝对差 > 2 的像素数。 */
  differ: number;
  meanAbs: number;
  maxAbs: number;
  maxAt: { x: number; y: number };
}

export interface LabSummary {
  points: number;
  meanDE00: number;
  maxDE00: number;
  maxAt: { x: number; y: number };
}

export interface CompareSummary {
  computedAt: string;
  aFingerprint: string;
  bFingerprint: string;
  pixel: PixelSummary;
  lab: LabSummary | null;
}

export interface StoredCompareJob {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  status: CompareJobStatus;
  /** 冻结的原始像素（直接从原图复制，永不经过任何一侧的转换输出）。 */
  image: {
    bytes: Uint8Array;
    name: string;
    hash: string;
    container: string;
    bitDepth: 8 | 16;
  };
  /** 冻结的已确认源配置。 */
  source: {
    profileBytes: Uint8Array;
    description: string;
    fingerprint: string;
    colorSpace: ColorSpaceKind;
    origin: 'embedded' | 'assumed';
    assumptionNote?: string;
  };
  sides: Record<SideId, CompareSide>;
  summary: CompareSummary | null;
  /** 在途摘要计算的版本令牌。 */
  summaryToken: string;
  pins: ComparePin[];
}

export interface CompareJobMeta {
  id: string;
  name: string;
  updatedAt: string;
  status: CompareJobStatus;
}

export function emptySide(): CompareSide {
  return { config: null, running: false, runToken: '', result: null, error: null, failedAt: null };
}

/** 条件指纹：参数文本在前、配置字节在后，一次 FNV-1a。 */
export function sideFingerprintOf(
  p: { intent: RenderingIntent; blackPointCompensation: boolean; proofIntent: RenderingIntent },
  profileBytes: Uint8Array,
): string {
  const head = new TextEncoder().encode(
    `${p.intent}|${p.blackPointCompensation ? 1 : 0}|${p.proofIntent}|`,
  );
  const buf = new Uint8Array(head.length + profileBytes.length);
  buf.set(head, 0);
  buf.set(profileBytes, head.length);
  return fnv1a64(buf);
}

/** 由配置库条目建立冻结的侧条件快照（字节逐份复制，互不影响）。 */
export function makeSideConfig(
  profile: { id: string; description: string; colorSpace: ColorSpaceKind; bytes: Uint8Array },
  params: { intent: RenderingIntent; blackPointCompensation: boolean; proofIntent: RenderingIntent },
): CompareSideConfig {
  const profileBytes = profile.bytes.slice();
  return {
    targetProfileId: profile.id,
    description: profile.description,
    colorSpace: profile.colorSpace,
    profileBytes,
    profileFingerprint: fnv1a64(profileBytes),
    intent: params.intent,
    blackPointCompensation: params.blackPointCompensation,
    proofIntent: params.proofIntent,
    fingerprint: sideFingerprintOf(params, profileBytes),
  };
}

/** 参数变更后重算条件指纹（配置字节不变）。 */
export function refreshSideFingerprint(config: CompareSideConfig): void {
  config.fingerprint = sideFingerprintOf(config, config.profileBytes);
}

/** 侧状态：结果指纹与当前条件指纹不一致 => 已过期。 */
export function effectiveSideStatus(side: CompareSide): SideStatus {
  if (side.running) return 'running';
  if (!side.config) return 'idle';
  if (side.result && side.result.configFingerprint === side.config.fingerprint) return 'done';
  if (side.error) return 'failed';
  if (side.result) return 'stale';
  return 'idle';
}

/** 作业状态：草稿 / 运行中 / 部分完成 / 完成 / 失败。 */
export function deriveJobStatus(job: StoredCompareJob): CompareJobStatus {
  const a = effectiveSideStatus(job.sides.A);
  const b = effectiveSideStatus(job.sides.B);
  if (a === 'running' || b === 'running') return 'running';
  const done = (a === 'done' ? 1 : 0) + (b === 'done' ? 1 : 0);
  if (done === 2) return 'complete';
  if (done === 1) return 'partial';
  if (a === 'failed' || b === 'failed') return 'failed';
  return 'draft';
}

/**
 * 运行结果归属判定：只有该侧仍处于同一次运行（runToken 未变）时才接受。
 * 修改条件、取消、重开作业都会更换 runToken，使迟到的结果被丢弃。
 */
export function shouldAcceptResult(side: CompareSide, runToken: string): boolean {
  return side.running && side.runToken === runToken && runToken !== '';
}

/** 均匀取样网格（用于整体 ΔE 摘要），每轴最多 maxPerAxis 个点。 */
export function gridPoints(width: number, height: number, maxPerAxis = 8): { x: number; y: number }[] {
  const nx = Math.max(1, Math.min(maxPerAxis, width));
  const ny = Math.max(1, Math.min(maxPerAxis, height));
  const pts: { x: number; y: number }[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      pts.push({
        x: Math.min(width - 1, Math.floor(((i + 0.5) * width) / nx)),
        y: Math.min(height - 1, Math.floor(((j + 0.5) * height) / ny)),
      });
    }
  }
  return pts;
}

/** 两侧软打样预览（同为显示器 sRGB 空间）的逐像素差异摘要。 */
export function computePixelSummary(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
): PixelSummary {
  const total = Math.max(1, Math.min(Math.floor(a.length / 4), Math.floor(b.length / 4), width * height));
  let differ = 0;
  let sum = 0;
  let max = 0;
  let maxIdx = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const d = Math.max(
      Math.abs(a[o] - b[o]),
      Math.abs(a[o + 1] - b[o + 1]),
      Math.abs(a[o + 2] - b[o + 2]),
    );
    if (d > 2) differ++;
    sum += d;
    if (d > max) {
      max = d;
      maxIdx = i;
    }
  }
  return {
    total,
    differ,
    meanAbs: sum / total,
    maxAbs: max,
    maxAt: { x: maxIdx % width, y: Math.floor(maxIdx / width) },
  };
}

export interface GridSample {
  x: number;
  y: number;
  a: SampleInfo | null;
  b: SampleInfo | null;
}

/** 网格点的双侧目标 Lab 之差（CIEDE2000）摘要；无有效点对时返回 null。 */
export function summarizeGrid(samples: GridSample[]): LabSummary | null {
  let n = 0;
  let sum = 0;
  let max = -1;
  let maxAt = { x: 0, y: 0 };
  for (const s of samples) {
    if (!s.a || !s.b) continue;
    const de = deltaE2000(fromTriple(s.a.targetLab), fromTriple(s.b.targetLab));
    n++;
    sum += de;
    if (de > max) {
      max = de;
      maxAt = { x: s.x, y: s.y };
    }
  }
  if (n === 0) return null;
  return { points: n, meanDE00: sum / n, maxDE00: max, maxAt: maxAt };
}

/** 摘要是否落后于当前两侧条件。 */
export function summaryStale(job: StoredCompareJob): boolean {
  const s = job.summary;
  if (!s) return true;
  return (
    s.aFingerprint !== job.sides.A.config?.fingerprint ||
    s.bFingerprint !== job.sides.B.config?.fingerprint
  );
}

/** 取样钉某一侧是否已过期（采样之后该侧条件又变过）。 */
export function pinSideStale(pin: ComparePin, side: CompareSide, which: SideId): boolean {
  const sampled = which === 'A' ? pin.aFingerprint : pin.bFingerprint;
  if (sampled === null) return false; // 尚未取得该侧样本，谈不上过期
  return sampled !== (side.config?.fingerprint ?? null);
}

/** 比较时间：优先整体摘要的计算时间，其次最晚的一侧完成时间。 */
export function comparisonTimeOf(job: StoredCompareJob): string {
  if (job.summary) return job.summary.computedAt;
  const times = [job.sides.A.result?.completedAt, job.sides.B.result?.completedAt]
    .filter((t): t is string => !!t)
    .sort();
  return times[times.length - 1] ?? job.updatedAt;
}

/** 导出用对比记录：含两侧条件指纹与比较时间。 */
export interface CompareRecord {
  recordFormat: typeof COMPARE_RECORD_FORMAT;
  createdAt: string;
  /** 比较时间（整体摘要计算时间 / 最晚侧完成时间）。 */
  comparisonTime: string;
  application: { name: 'softproof-bench'; version: string };
  job: { id: string; name: string; status: CompareJobStatus };
  image: { name: string; hash: string; container: string; bitDepth: 8 | 16 };
  source: {
    description: string;
    fingerprint: string;
    colorSpace: ColorSpaceKind;
    origin: 'embedded' | 'assumed';
    assumptionNote?: string;
  };
  sides: Record<
    SideId,
    {
      targetProfileId: string;
      description: string;
      colorSpace: ColorSpaceKind;
      profileFingerprint: string;
      /** 侧条件指纹（目标配置 + 意图 + BPC + 软打样意图）。 */
      fingerprint: string;
      intent: RenderingIntent;
      intentCode: number;
      blackPointCompensation: boolean;
      proofIntent: RenderingIntent;
      proofIntentCode: number;
      status: SideStatus;
      completedAt: string | null;
      error: string | null;
    }
  >;
  summary: CompareSummary | null;
  pins: {
    x: number;
    y: number;
    aLab: [number, number, number] | null;
    bLab: [number, number, number] | null;
    deltaE00: number | null;
    stale: boolean;
  }[];
  /** 独立性声明：两侧均直接由原始像素计算。 */
  independence: string;
  disclaimer: string;
}

export function buildCompareRecord(
  job: StoredCompareJob,
  now: string,
  appVersion: string,
): CompareRecord {
  const sideRec = (side: CompareSide): CompareRecord['sides'][SideId] => ({
    targetProfileId: side.config?.targetProfileId ?? '',
    description: side.config?.description ?? '',
    colorSpace: side.config?.colorSpace ?? 'other',
    profileFingerprint: side.config?.profileFingerprint ?? '',
    fingerprint: side.config?.fingerprint ?? '',
    intent: side.config?.intent ?? 'relative-colorimetric',
    intentCode: INTENT_CODE[side.config?.intent ?? 'relative-colorimetric'],
    blackPointCompensation: side.config?.blackPointCompensation ?? false,
    proofIntent: side.config?.proofIntent ?? 'relative-colorimetric',
    proofIntentCode: INTENT_CODE[side.config?.proofIntent ?? 'relative-colorimetric'],
    status: effectiveSideStatus(side),
    completedAt: side.result?.completedAt ?? null,
    error: side.error,
  });
  return {
    recordFormat: COMPARE_RECORD_FORMAT,
    createdAt: now,
    comparisonTime: comparisonTimeOf(job),
    application: { name: 'softproof-bench', version: appVersion },
    job: { id: job.id, name: job.name, status: deriveJobStatus(job) },
    image: {
      name: job.image.name,
      hash: job.image.hash,
      container: job.image.container,
      bitDepth: job.image.bitDepth,
    },
    source: {
      description: job.source.description,
      fingerprint: job.source.fingerprint,
      colorSpace: job.source.colorSpace,
      origin: job.source.origin,
      assumptionNote: job.source.assumptionNote,
    },
    sides: { A: sideRec(job.sides.A), B: sideRec(job.sides.B) },
    summary: job.summary,
    pins: job.pins
      .filter((p) => !p.pending)
      .map((p) => {
        const de = p.a && p.b ? deltaE2000(fromTriple(p.a.targetLab), fromTriple(p.b.targetLab)) : null;
        const stale =
          (p.aFingerprint !== null && p.aFingerprint !== job.sides.A.config?.fingerprint) ||
          (p.bFingerprint !== null && p.bFingerprint !== job.sides.B.config?.fingerprint);
        return {
          x: p.x,
          y: p.y,
          aLab: p.a?.targetLab ?? null,
          bLab: p.b?.targetLab ?? null,
          deltaE00: de,
          stale,
        };
      }),
    independence:
      'A/B 两侧均直接由同一原始像素与同一已确认源配置计算；任何一侧的转换结果都不会作为另一侧的输入。',
    disclaimer: DISCLAIMER,
  };
}
