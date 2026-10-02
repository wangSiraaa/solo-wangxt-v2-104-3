/// <reference lib="webworker" />
/**
 * Worker: owns the LittleCMS WASM instance and all pixel work.
 * Protocol (messages are plain structured-clone values):
 *
 *  -> { type: 'convert', id, imageBytes, sourceIcc, targetIcc, params, attribution? }
 *  <-  { type: 'result', id, result?, error?, attribution? }
 *
 *  -> { type: 'sample', id, imageBytes, sourceIcc, targetIcc, params, x, y }
 *  <-  { type: 'sample-result', id, info?, error? }
 *
 *  -> { type: 'compare-sample', id, attribution, imageBytes, sourceIcc,
 *       sideA: {targetIcc, params}, sideB: {targetIcc, params}, points }
 *  <-  { type: 'compare-sample-result', id, attribution, samples, error? }
 *
 * `attribution` (jobId + runToken + side) is echoed back verbatim so the
 * caller can bind every response to exactly one comparison-job version;
 * stale tokens are discarded by the caller.
 *
 * Profiles and images arrive as ArrayBuffers (zero-copy transfer when sent
 * from the caller with a transfer list; here we clone to keep originals).
 */
import { decodeImage, type DecodedImage } from '../codec/decode';
import { convert, samplePixel, samplePoints } from '../color/engine';
import type { EngineParams, SampleInfo } from '../color/engine';

declare const self: DedicatedWorkerGlobalScope;

export interface Attribution {
  jobId: string;
  runToken: string;
  side?: 'A' | 'B';
}

export interface ConvertRequest {
  type: 'convert';
  id: number;
  imageBytes: ArrayBuffer;
  sourceIcc: ArrayBuffer;
  targetIcc: ArrayBuffer;
  params: EngineParams;
  attribution?: Attribution;
}
export interface SampleRequest {
  type: 'sample';
  id: number;
  imageBytes: ArrayBuffer;
  sourceIcc: ArrayBuffer;
  targetIcc: ArrayBuffer;
  params: EngineParams;
  x: number;
  y: number;
}
export interface CompareSampleRequest {
  type: 'compare-sample';
  id: number;
  attribution?: Attribution;
  imageBytes: ArrayBuffer;
  sourceIcc: ArrayBuffer;
  sideA: { targetIcc: ArrayBuffer; params: EngineParams };
  sideB: { targetIcc: ArrayBuffer; params: EngineParams };
  points: { x: number; y: number }[];
}
export type WorkerRequest = ConvertRequest | SampleRequest | CompareSampleRequest;

export interface ComparePointSample {
  x: number;
  y: number;
  a: SampleInfo | null;
  b: SampleInfo | null;
  aError?: string;
  bError?: string;
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    const imageBytes = new Uint8Array(msg.imageBytes);
    const decoded = await decodeImage(imageBytes);
    if (msg.type === 'convert') {
      const profiles = {
        source: { bytes: new Uint8Array(msg.sourceIcc), description: 'source' },
        target: { bytes: new Uint8Array(msg.targetIcc), description: 'target' },
      };
      const result = await convert(decoded, profiles, msg.params);
      // Copy underlying buffers into fresh transferable snapshots.
      self.postMessage(
        {
          type: 'result',
          id: msg.id,
          result: serialize(result),
          attribution: msg.attribution,
        },
        transferableOf(result),
      );
    } else if (msg.type === 'compare-sample') {
      const samples = await compareSample(decoded, msg);
      self.postMessage({
        type: 'compare-sample-result',
        id: msg.id,
        attribution: msg.attribution,
        samples,
      });
    } else {
      const profiles = {
        source: { bytes: new Uint8Array(msg.sourceIcc), description: 'source' },
        target: { bytes: new Uint8Array(msg.targetIcc), description: 'target' },
      };
      const info = await samplePixel(decoded, profiles, msg.params, msg.x, msg.y);
      self.postMessage({ type: 'sample-result', id: msg.id, info });
    }
  } catch (err) {
    self.postMessage({
      type: msg.type === 'sample' ? 'sample-result' : msg.type === 'compare-sample' ? 'compare-sample-result' : 'result',
      id: msg.id,
      attribution: 'attribution' in msg ? msg.attribution : undefined,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

/**
 * Sample both comparison sides from the SAME decoded original pixels. Each
 * side's target profile is opened independently: a broken profile fails only
 * its own column, never the other side's.
 */
async function compareSample(decoded: DecodedImage, msg: CompareSampleRequest): Promise<ComparePointSample[]> {
  const sourceBytes = new Uint8Array(msg.sourceIcc);
  const runSide = async (spec: { targetIcc: ArrayBuffer; params: EngineParams }, label: string) =>
    samplePoints(
      decoded,
      {
        source: { bytes: sourceBytes, description: 'source' },
        target: { bytes: new Uint8Array(spec.targetIcc), description: label },
      },
      spec.params,
      msg.points,
    );
  let a: SampleInfo[] | null = null;
  let b: SampleInfo[] | null = null;
  let aError: string | undefined;
  let bError: string | undefined;
  try {
    a = await runSide(msg.sideA, 'A');
  } catch (err) {
    aError = err instanceof Error ? err.message : String(err);
  }
  try {
    b = await runSide(msg.sideB, 'B');
  } catch (err) {
    bError = err instanceof Error ? err.message : String(err);
  }
  return msg.points.map((p, i) => ({
    x: p.x,
    y: p.y,
    a: a?.[i] ?? null,
    b: b?.[i] ?? null,
    aError,
    bError,
  }));
}

function serialize(r: Awaited<ReturnType<typeof convert>>): {
  width: number;
  height: number;
  bitDepth: 8 | 16;
  targetColorSpace: string;
  converted: ArrayBuffer;
  convertedColorChannels: 1 | 3 | 4;
  convertedChannels: number;
  softProofRGBA: ArrayBuffer;
  hasAlpha: boolean;
} {
  return {
    width: r.width,
    height: r.height,
    bitDepth: r.bitDepth,
    targetColorSpace: r.targetColorSpace,
    converted: bufferOf(r.converted),
    convertedColorChannels: r.convertedColorChannels,
    convertedChannels: r.convertedChannels,
    softProofRGBA: bufferOf(r.softProofRGBA),
    hasAlpha: r.hasAlpha,
  };
}

function bufferOf(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}
function transferableOf(r: Awaited<ReturnType<typeof convert>>): ArrayBuffer[] {
  return [
    r.converted.buffer.slice(r.converted.byteOffset, r.converted.byteOffset + r.converted.byteLength) as ArrayBuffer,
    r.softProofRGBA.buffer.slice(
      r.softProofRGBA.byteOffset,
      r.softProofRGBA.byteOffset + r.softProofRGBA.byteLength,
    ) as ArrayBuffer,
  ];
}
