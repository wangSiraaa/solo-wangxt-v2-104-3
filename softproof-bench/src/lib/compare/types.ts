/**
 * 打样条件对比（proofing-condition comparison）的域模型与纯函数。
 *
 * 纪律要点：
 *  - 作业在建档时冻结“原始像素 + 已确认源配置 + 两侧目标配置”的字节副本；
 *    之后主面板的任何选择变化都不会影响已建对比。
 *  - 两侧各自从同一份原始像素与同一份冻结源配置直接计算；任何一侧的
 *    转换结果都不会成为另一侧的输入。
 *  - 结果按 (作业 id, runVersion, 侧, 条件指纹) 归属；修改条件、取消或
 *    删除作业后到达的旧结果一律丢弃（见 compare.svelte.ts）。
 *  - “已过期”是派生状态：结果上的 specHash 与当前条件指纹不一致即过期，
 *    重新加载后依然成立，不需要命令式标记。
 *
 * 本模块不依赖 svelte / worker / IndexedDB，可在 Node 下单测。
 */
import type { RenderingIntent } from '../color/lcms';
import type { ColorSpaceKind } from '../icc/profileInfo';
import type { SampleInfo } from '../color/engine';
import { fnv1a64str } from '../color/hash';
import { deltaE2000, fromTriple } from '../color/colorMath';
import { DISCLAIMER } from '../color/record';

export type SideKey = 'A' | 'B';
export const SIDE_KEYS: SideKey[] = ['A', 'B'];

export type SideDisplayStatus = 'empty' | 'pending' | 'running' | 'done' | 'failed' | 'stale';
export type CompareJobStatus = 'draft' | 'running' | 'partial' | 'done' | 'failed';

export const JOB_STATUS_LABEL: Record<CompareJobStatus, string> = {
  draft: '草稿',
  running: '运行中',
  partial: '部分完成',
  done: '完成',
  failed: '失败',
};

export const SIDE_STATUS_LABEL: Record<SideDisplayStatus, string> = {
  empty: '未配置',
  pending: '待运行',
  running: '运行中',
  done: '完成',
  failed: '失败',
  stale: '已过期',
};

/** ICC 标准渲染意图码（与 lcms.INTENT_VALUE 一致；此处独立以免拖入 WASM 依赖）。 */
export const INTENT_CODE: Record<RenderingIntent, number> = {
  perceptual: 0,
  'relative-colorimetric': 1,
  saturation: 2,
  'absolute-colorimetric': 3,
};

/** 一侧的冻结打样条件：目标配置字节 + 渲染意图 + 黑点补偿 + 软打样意图。 */
export interface CompareSideSpec {
  /** 建档/选择时库中的配置 id（仅作标识；运行不依赖库）。 */
  targetProfileId: string;
  targetDescription: string;
  targetColorSpace: ColorSpaceKind | '';
  /** 冻结的配置字节副本 —— 对比作业从不回读配置库。 */
  targetBytes: Uint8Array;
  /** fnv1a64(targetBytes)，即该侧的配置指纹。 */
  profileHash: string;
  intent: RenderingIntent;
  blackPointCompensation: boolean;
  proofIntent: RenderingIntent;
}

export interface CompareSideResult {
  status: 'done' | 'failed';
  /** 产生该结果时分派的作业版本。 */
  runVersion: number;
  /** 该结果计算时使用的条件指纹。 */
  specHash: string;
  width: number;
  height: number;
  targetColorSpace?: ColorSpaceKind;
  /** 8-bit RGBA 软打样预览（源 → 目标 proof → 显示器）。 */
  softProofRGBA?: Uint8Array;
  error?: string;
  completedAt: string;
}

export interface CompareSide {
  spec: CompareSideSpec;
  /** 在途分派的 runVersion；null 表示空闲。 */
  runningVersion: number | null;
  /** 最近一次“落定”的结果（可能已过期 —— 由 specHash 派生）。 */
  result: CompareSideResult | null;
}

/** 可定位的取样点：同一坐标在两侧条件下各自的数值。 */
export interface ComparePin {
  id: string;
  x: number;
  y: number;
  A: SampleInfo | null;
  B: SampleInfo | null;
  /** 取样时两侧各自的条件指纹；与当前指纹不一致即该侧读数过期。 */
  specHashA: string;
  specHashB: string;
  errorA?: string;
  errorB?: string;
}

/** 整体比较摘要：网格取样两侧目标 Lab 的 ΔE2000 统计。 */
export interface CompareSummary {
  computedAt: string;
  specHashA: string;
  specHashB: string;
  samples: number;
  meanDE: number;
  maxDE: number;
  /** 最大差异位置（可定位证据）。 */
  maxX: number;
  maxY: number;
  over2: number;
  over5: number;
}

export interface StoredComparison {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  status: CompareJobStatus;
  /** 每次分派/取消递增；在途结果只认分派时的版本。 */
  runVersion: number;
  image: {
    name: string;
    container: string;
    bitDepth: 8 | 16;
    width: number;
    height: number;
    /** fnv1a64(原始文件字节)。 */
    hash: string;
    /** 冻结的原始像素文件字节 —— 两侧转换的唯一输入。 */
    bytes: Uint8Array;
  };
  source: {
    description: string;
    colorSpace: ColorSpaceKind;
    /** embedded = 嵌入 ICC；assumed = 缺 ICC 时操作员确认的假设。 */
    origin: 'embedded' | 'assumed';
    hash: string;
    bytes: Uint8Array;
  };
  sides: Record<SideKey, CompareSide>;
  pins: ComparePin[];
  summary: CompareSummary | null;
}

export function emptySideSpec(): CompareSideSpec {
  return {
    targetProfileId: '',
    targetDescription: '',
    targetColorSpace: '',
    targetBytes: new Uint8Array(0),
    profileHash: '',
    intent: 'relative-colorimetric',
    blackPointCompensation: true,
    proofIntent: 'relative-colorimetric',
  };
}

export function specComplete(spec: CompareSideSpec): boolean {
  return spec.targetProfileId !== '' && spec.targetBytes.byteLength > 0;
}

/**
 * 一侧条件的指纹：同一原稿 + 同一源配置 + 该侧全部打样条件。
 * 任一条件变化都会改变指纹，从而使旧结果/旧取样/旧摘要派生为“过期”。
 */
export function sideSpecHash(
  job: Pick<StoredComparison, 'image' | 'source'>,
  spec: CompareSideSpec,
): string {
  return fnv1a64str(
    [
      job.image.hash,
      job.source.hash,
      spec.profileHash,
      spec.intent,
      spec.blackPointCompensation ? 'bpc1' : 'bpc0',
      spec.proofIntent,
    ].join('|'),
  );
}

/** 单侧的展示状态（纯派生，不落库）。 */
export function sideDisplayStatus(job: StoredComparison, side: SideKey): SideDisplayStatus {
  const s = job.sides[side];
  if (s.runningVersion !== null) return 'running';
  if (!specComplete(s.spec)) return 'empty';
  if (!s.result) return 'pending';
  if (s.result.specHash !== sideSpecHash(job, s.spec)) return 'stale';
  return s.result.status;
}

/** 作业级状态机：草稿 / 运行中 / 部分完成 / 完成 / 失败。 */
export function deriveJobStatus(job: StoredComparison): CompareJobStatus {
  const a = sideDisplayStatus(job, 'A');
  const b = sideDisplayStatus(job, 'B');
  if (a === 'running' || b === 'running') return 'running';
  const done = (s: SideDisplayStatus) => s === 'done';
  const fail = (s: SideDisplayStatus) => s === 'failed';
  if (done(a) && done(b)) return 'done';
  if (fail(a) && fail(b)) return 'failed';
  if (done(a) || done(b)) return 'partial';
  if (fail(a) || fail(b)) return 'failed';
  return 'draft';
}

/** 均匀网格取样点（去重、夹取到图内），用于整体比较摘要。 */
export function gridPoints(width: number, height: number, n = 5): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  const seen = new Set<string>();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = Math.min(width - 1, Math.max(0, Math.round(((i + 0.5) / n) * (width - 1))));
      const y = Math.min(height - 1, Math.max(0, Math.round(((j + 0.5) / n) * (height - 1))));
      const key = `${x},${y}`;
      if (!seen.has(key)) {
        seen.add(key);
        pts.push({ x, y });
      }
    }
  }
  return pts;
}

/** 由两侧同点取样（目标 Lab）计算 ΔE2000 摘要。 */
export function summarizeSamples(
  pts: { x: number; y: number }[],
  infosA: SampleInfo[],
  infosB: SampleInfo[],
  specHashA: string,
  specHashB: string,
  computedAt: string,
): CompareSummary {
  let sum = 0;
  let max = -1;
  let maxX = 0;
  let maxY = 0;
  let over2 = 0;
  let over5 = 0;
  const count = Math.min(pts.length, infosA.length, infosB.length);
  for (let i = 0; i < count; i++) {
    const de = deltaE2000(fromTriple(infosA[i].targetLab), fromTriple(infosB[i].targetLab));
    sum += de;
    if (de > max) {
      max = de;
      maxX = pts[i].x;
      maxY = pts[i].y;
    }
    if (de > 2) over2++;
    if (de > 5) over5++;
  }
  return {
    computedAt,
    specHashA,
    specHashB,
    samples: count,
    meanDE: count ? sum / count : 0,
    maxDE: count ? max : 0,
    maxX,
    maxY,
    over2,
    over5,
  };
}

export const COMPARE_RECORD_FORMAT = 'softproof-bench-compare/1';

/**
 * 对比导出记录：两侧配置指纹（目标配置哈希 + 条件指纹）、原稿与源配置
 * 指纹、比较时间、取样证据与整体摘要。
 */
export function buildCompareRecord(job: StoredComparison, exportedAt = new Date().toISOString()) {
  const sideRecord = (k: SideKey) => {
    const s = job.sides[k];
    return {
      target: {
        id: s.spec.targetProfileId,
        description: s.spec.targetDescription,
        colorSpace: s.spec.targetColorSpace,
        profileHash: s.spec.profileHash,
        byteLength: s.spec.targetBytes.byteLength,
      },
      intent: s.spec.intent,
      intentCode: INTENT_CODE[s.spec.intent],
      blackPointCompensation: s.spec.blackPointCompensation,
      proofIntent: s.spec.proofIntent,
      proofIntentCode: INTENT_CODE[s.spec.proofIntent],
      /** 该侧完整条件指纹（原稿+源+目标+意图+BPC+软打样意图）。 */
      specFingerprint: specComplete(s.spec) ? sideSpecHash(job, s.spec) : null,
      status: sideDisplayStatus(job, k),
      completedAt: s.result?.completedAt ?? null,
      error: s.result?.error,
    };
  };
  return {
    recordFormat: COMPARE_RECORD_FORMAT,
    exportedAt,
    application: { name: 'softproof-bench', version: '0.1.0' },
    comparison: {
      id: job.id,
      name: job.name,
      status: deriveJobStatus(job),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    },
    image: {
      name: job.image.name,
      container: job.image.container,
      bitDepth: job.image.bitDepth,
      width: job.image.width,
      height: job.image.height,
      pixelHash: job.image.hash,
    },
    source: {
      description: job.source.description,
      colorSpace: job.source.colorSpace,
      origin: job.source.origin,
      profileHash: job.source.hash,
    },
    sides: { A: sideRecord('A'), B: sideRecord('B') },
    /** 整体摘要的计算时间即“比较时间”；未计算则为 null。 */
    comparedAt: job.summary?.computedAt ?? null,
    summary: job.summary,
    pins: job.pins.map((p) => ({
      x: p.x,
      y: p.y,
      sideA: p.A
        ? { device: p.A.targetDevice, lab: p.A.targetLab, colorSpace: p.A.targetColorSpace }
        : null,
      sideB: p.B
        ? { device: p.B.targetDevice, lab: p.B.targetLab, colorSpace: p.B.targetColorSpace }
        : null,
      deltaE00:
        p.A && p.B ? deltaE2000(fromTriple(p.A.targetLab), fromTriple(p.B.targetLab)) : null,
      staleA: p.A ? p.specHashA !== sideSpecHash(job, job.sides.A.spec) : undefined,
      staleB: p.B ? p.specHashB !== sideSpecHash(job, job.sides.B.spec) : undefined,
    })),
    disclaimer: DISCLAIMER,
  };
}
