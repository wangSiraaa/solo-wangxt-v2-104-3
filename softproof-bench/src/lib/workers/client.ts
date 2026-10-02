/**
 * Main-thread client for the color worker. Requests keep the original image
 * and profile bytes in memory; transferred buffers are copies so the saved
 * project is never detached.
 *
 * Comparison requests carry an `attribution` { jobId, runToken, side } token
 * that the worker echoes back verbatim; the compare store only accepts a
 * result whose token still matches the job's current version.
 */
import ColorWorker from './color.worker.ts?worker';
import type { EngineParams, SampleInfo } from '../color/engine';
import type { ColorSpaceKind } from '../icc/profileInfo';
import type { Attribution, ComparePointSample } from './color.worker';

export interface ConvertedPayload {
  width: number;
  height: number;
  bitDepth: 8 | 16;
  targetColorSpace: ColorSpaceKind;
  converted: Uint8Array;
  convertedColorChannels: 1 | 3 | 4;
  convertedChannels: number;
  softProofRGBA: Uint8Array;
  hasAlpha: boolean;
}

export interface CompareSideRun {
  attribution: Attribution;
  payload: ConvertedPayload;
}

export interface CompareSampleRun {
  attribution?: Attribution;
  samples: ComparePointSample[];
}

let worker: Worker | null = null;
let seq = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker {
  if (!worker) {
    worker = new ColorWorker();
    worker.onmessage = (ev: MessageEvent) => {
      const { id, error } = ev.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) p.reject(new CompareWorkerError(error, ev.data.attribution));
      else if (ev.data.type === 'result') {
        const payload = toConverted(ev.data.result);
        const attribution = ev.data.attribution as Attribution | undefined;
        p.resolve(attribution ? { attribution, payload } : payload);
      } else if (ev.data.type === 'compare-sample-result') {
        p.resolve({ attribution: ev.data.attribution, samples: ev.data.samples } as CompareSampleRun);
      } else p.resolve(ev.data.info as SampleInfo);
    };
    worker.onerror = (e) => {
      const err = new Error(e.message || '色彩工作线程错误');
      pending.forEach((p) => p.reject(err));
      pending.clear();
    };
  }
  return worker;
}

/** Worker error that still carries the job-version attribution it belongs to. */
export class CompareWorkerError extends Error {
  attribution?: Attribution;
  constructor(message: string, attribution?: Attribution) {
    super(message);
    this.attribution = attribution;
  }
}

function copy(buf: ArrayBuffer): ArrayBuffer {
  return buf.slice(0);
}

function toConverted(r: {
  width: number;
  height: number;
  bitDepth: 8 | 16;
  targetColorSpace: ColorSpaceKind;
  converted: ArrayBuffer;
  convertedColorChannels: 1 | 3 | 4;
  convertedChannels: number;
  softProofRGBA: ArrayBuffer;
  hasAlpha: boolean;
}): ConvertedPayload {
  return {
    width: r.width,
    height: r.height,
    bitDepth: r.bitDepth,
    targetColorSpace: r.targetColorSpace,
    converted: new Uint8Array(r.converted),
    convertedColorChannels: r.convertedColorChannels,
    convertedChannels: r.convertedChannels,
    softProofRGBA: new Uint8Array(r.softProofRGBA),
    hasAlpha: r.hasAlpha,
  };
}

export function runConvert(opts: {
  imageBytes: Uint8Array;
  sourceIcc: Uint8Array;
  targetIcc: Uint8Array;
  params: EngineParams;
}): Promise<ConvertedPayload> {
  const w = ensureWorker();
  const id = seq++;
  const payload = {
    type: 'convert' as const,
    id,
    imageBytes: copy(ab(opts.imageBytes)),
    sourceIcc: copy(ab(opts.sourceIcc)),
    targetIcc: copy(ab(opts.targetIcc)),
    params: opts.params,
  };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage(payload, [payload.imageBytes, payload.sourceIcc, payload.targetIcc]);
  });
}

/**
 * Run ONE side of a comparison job: always from the job's frozen original
 * pixels and frozen source profile — never from the other side's output.
 */
export function runCompareSide(opts: {
  attribution: Attribution;
  imageBytes: Uint8Array;
  sourceIcc: Uint8Array;
  targetIcc: Uint8Array;
  params: EngineParams;
}): Promise<CompareSideRun> {
  const w = ensureWorker();
  const id = seq++;
  const payload = {
    type: 'convert' as const,
    id,
    imageBytes: copy(ab(opts.imageBytes)),
    sourceIcc: copy(ab(opts.sourceIcc)),
    targetIcc: copy(ab(opts.targetIcc)),
    params: opts.params,
    attribution: opts.attribution,
  };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage(payload, [payload.imageBytes, payload.sourceIcc, payload.targetIcc]);
  });
}

/**
 * Sample a batch of points for BOTH comparison sides in one round trip; the
 * worker decodes the frozen original once and measures each side from it.
 */
export function runCompareSamples(opts: {
  attribution: Attribution;
  imageBytes: Uint8Array;
  sourceIcc: Uint8Array;
  sideA: { targetIcc: Uint8Array; params: EngineParams };
  sideB: { targetIcc: Uint8Array; params: EngineParams };
  points: { x: number; y: number }[];
}): Promise<CompareSampleRun> {
  const w = ensureWorker();
  const id = seq++;
  const payload = {
    type: 'compare-sample' as const,
    id,
    attribution: opts.attribution,
    imageBytes: copy(ab(opts.imageBytes)),
    sourceIcc: copy(ab(opts.sourceIcc)),
    sideA: { targetIcc: copy(ab(opts.sideA.targetIcc)), params: opts.sideA.params },
    sideB: { targetIcc: copy(ab(opts.sideB.targetIcc)), params: opts.sideB.params },
    points: opts.points,
  };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage(payload, [payload.imageBytes, payload.sourceIcc, payload.sideA.targetIcc, payload.sideB.targetIcc]);
  });
}

export function runSample(opts: {
  imageBytes: Uint8Array;
  sourceIcc: Uint8Array;
  targetIcc: Uint8Array;
  params: EngineParams;
  x: number;
  y: number;
}): Promise<SampleInfo> {
  const w = ensureWorker();
  const id = seq++;
  const payload = {
    type: 'sample' as const,
    id,
    imageBytes: copy(ab(opts.imageBytes)),
    sourceIcc: copy(ab(opts.sourceIcc)),
    targetIcc: copy(ab(opts.targetIcc)),
    params: opts.params,
    x: opts.x,
    y: opts.y,
  };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage(payload, [payload.imageBytes, payload.sourceIcc, payload.targetIcc]);
  });
}

function ab(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}
