/**
 * Node-side unit tests for the pure modules: ICC parse/extract, PNG encoder
 * (incl. iCCP + provenance), TIFF CMYK encoder, and color math.
 *
 * Run: npx tsx scripts/test-node.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readProfileInfo } from '../src/lib/icc/profileInfo';
import { extractEmbeddedICC } from '../src/lib/icc/extractEmbedded';
import { encodePng } from '../src/lib/codec/png';
import { encodeTiffCmyk } from '../src/lib/codec/tiff';
import { detectProvenance } from '../src/lib/icc/provenance';
import { deltaE2000 } from '../src/lib/color/colorMath';
import { fnv1a64 } from '../src/lib/color/hash';
import {
  buildCompareRecord,
  deriveJobStatus,
  emptySideSpec,
  gridPoints,
  sideDisplayStatus,
  sideSpecHash,
  specComplete,
  summarizeSamples,
  type CompareSideSpec,
  type StoredComparison,
} from '../src/lib/compare/types';
import type { SampleInfo } from '../src/lib/color/engine';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, 'test-out');
mkdirSync(outDir, { recursive: true });

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.error(`  FAIL - ${name} ${detail}`);
  }
}

console.log('# ICC profiles');
const srgbIcc = readFileSync(resolve(root, 'public/profiles/sRGB-elle-V2-srgbtrc.icc'));
const cieIcc = readFileSync(resolve(root, 'public/profiles/CIERGB-elle-V2-g22.icc'));
const cmykIcc = readFileSync(resolve('/workspace/test-assets/profiles/ISOcoated_v2_300_mth.icc'));

const sInfo = readProfileInfo(srgbIcc);
check('sRGB profile parsed', sInfo.valid && sInfo.colorSpace === 'RGB' && sInfo.channels === 3, JSON.stringify(sInfo));
check('sRGB description non-empty', sInfo.description.length > 3, sInfo.description);
const cInfo = readProfileInfo(new Uint8Array(cmykIcc));
check('CMYK profile parsed', cInfo.valid && cInfo.colorSpace === 'CMYK' && cInfo.channels === 4, cInfo.description);

console.log('# Color patch PNG (8-bit RGBA, transparent borders)');
// 4x3 image: corners fully transparent, interior solid primaries + mid gray
const W = 4,
  H = 3;
const rgba = new Uint8Array(W * H * 4);
const px = (x: number, y: number, r: number, g: number, b: number, a: number) => {
  const i = (y * W + x) * 4;
  rgba.set([r, g, b, a], i);
};
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px(x, y, 200, 200, 200, 255);
px(0, 0, 255, 0, 0, 0); // transparent corner
px(W - 1, 0, 0, 255, 0, 0);
px(0, H - 1, 0, 0, 255, 0);
px(W - 1, H - 1, 255, 255, 0, 0);
px(1, 1, 255, 0, 0, 255);
px(2, 1, 0, 255, 0, 255);
px(1, 2, 0, 0, 255, 255);
px(2, 2, 128, 128, 128, 255);

const pngBytes = encodePng({
  width: W,
  height: H,
  colorChannels: 3,
  bitDepth: 8,
  data: rgba,
  hasAlpha: true,
  icc: srgbIcc,
  iccName: 'sRGB test',
  text: {
    'softproof-bench-conversion':
      'v=1; source=test; target=CIERGB; intent=relative-colorimetric; bpc=1; this-file-is-converted-not-original=1',
  },
});
writeFileSync(resolve(outDir, 'patches.png'), pngBytes);
check('PNG signature', pngBytes.subarray(0, 8).join(',') === [137, 80, 78, 71, 13, 10, 26, 10].join(','));
const reIcc = extractEmbeddedICC(pngBytes);
check('iCCP round-trips byte-for-byte', !!reIcc && Buffer.from(reIcc).equals(Buffer.from(srgbIcc)));
const prov = detectProvenance(pngBytes);
check('provenance marker detected in PNG', prov.converted);

console.log('# 16-bit gray PNG');
const g16 = new Uint16Array(W * H);
for (let i = 0; i < g16.length; i++) g16[i] = i * 4000;
const gPng = encodePng({
  width: W,
  height: H,
  colorChannels: 1,
  bitDepth: 16,
  data: new Uint8Array(g16.buffer),
  hasAlpha: false,
  icc: srgbIcc,
});
writeFileSync(resolve(outDir, 'gray16.png'), gPng);
check('16-bit PNG produced', gPng.length > W * H * 2 + 50);

console.log('# CMYK TIFF');
const cmyk = new Uint8Array(W * H * 4);
const inks = [
  [0, 0, 0, 0],
  [255, 0, 0, 0],
  [0, 255, 0, 0],
  [0, 0, 255, 0],
  [0, 0, 0, 255],
  [10, 20, 30, 40],
  [200, 100, 50, 25],
  [0, 0, 0, 128],
  [128, 128, 128, 128],
  [5, 5, 5, 5],
  [30, 60, 90, 120],
  [255, 255, 255, 255],
];
for (let i = 0; i < W * H; i++) cmyk.set(inks[i % inks.length], i * 4);
const tif = encodeTiffCmyk({
  width: W,
  height: H,
  data: cmyk,
  channels: 4,
  icc: new Uint8Array(cmykIcc),
  description: 'softproof-bench-conversion: CMYK export test; this-file-is-converted-not-original=1',
});
writeFileSync(resolve(outDir, 'patches-cmyk.tif'), tif);
check('TIFF II header', tif[0] === 0x49 && tif[1] === 0x49);
const tProv = detectProvenance(tif);
check('provenance marker detected in TIFF', tProv.converted);

console.log('# embedded ICC extraction from JPEG / 16-bit PNG');
{
  const browserDir = resolve(root, 'test-assets/browser');
  const jpegIcc = extractEmbeddedICC(readFileSync(resolve(browserDir, 'patches-srgb.jpg')));
  check('JPEG APP2 ICC extracted', !!jpegIcc && jpegIcc!.byteLength === srgbIcc.byteLength, String(jpegIcc?.byteLength));
  if (jpegIcc) {
    const ji = readProfileInfo(jpegIcc);
    check('JPEG embedded ICC parses as sRGB', ji.valid && ji.colorSpace === 'RGB', ji.description);
  }
  const noIcc = extractEmbeddedICC(readFileSync(resolve(browserDir, 'patches-noicc.jpg')));
  check('JPEG without profile returns null', noIcc === null);
  const p16Icc = extractEmbeddedICC(readFileSync(resolve(browserDir, 'patches-srgb16.png')));
  check('16-bit PNG iCCP extracted byte-for-byte', !!p16Icc && Buffer.from(p16Icc!).equals(Buffer.from(srgbIcc)));
}

console.log('# color math');
// Black vs white CIEDE2000 ~= 100
const de = deltaE2000({ L: 0, a: 0, b: 0 }, { L: 100, a: 0, b: 0 });
check('dE00 black-white ~100', Math.abs(de - 100) < 0.01, String(de));
check('dE00 identical = 0', deltaE2000({ L: 50, a: 10, b: -10 }, { L: 50, a: 10, b: -10 }) === 0);
const h1 = fnv1a64(new Uint8Array([1, 2, 3]));
check('hash stable & hex16', h1.length === 16 && h1 === fnv1a64(new Uint8Array([1, 2, 3])) && h1 !== fnv1a64(new Uint8Array([1, 2, 4])));

console.log('# 打样条件对比（域模型）');
{
  const mkSpec = (over: Partial<CompareSideSpec> = {}): CompareSideSpec => ({
    ...emptySideSpec(),
    targetProfileId: 'builtin-srgb-elle',
    targetDescription: 'sRGB test',
    targetColorSpace: 'RGB',
    targetBytes: new Uint8Array(srgbIcc),
    profileHash: fnv1a64(new Uint8Array(srgbIcc)),
    ...over,
  });
  const mkJob = (): StoredComparison => ({
    id: 'cmp-test',
    name: 'test',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    status: 'draft',
    runVersion: 0,
    image: {
      name: 'patches.png',
      container: 'png',
      bitDepth: 8,
      width: 12,
      height: 8,
      hash: fnv1a64(new Uint8Array([1, 2, 3])),
      bytes: new Uint8Array([1, 2, 3]),
    },
    source: {
      description: 'sRGB',
      colorSpace: 'RGB',
      origin: 'embedded',
      hash: fnv1a64(new Uint8Array(srgbIcc)),
      bytes: new Uint8Array(srgbIcc),
    },
    sides: {
      A: { spec: mkSpec(), runningVersion: null, result: null },
      B: { spec: mkSpec({ targetProfileId: 'builtin-ciergb-elle', targetBytes: new Uint8Array(cieIcc), profileHash: fnv1a64(new Uint8Array(cieIcc)) }), runningVersion: null, result: null },
    },
    pins: [],
    summary: null,
  });

  const job = mkJob();
  check('空条件不完整', !specComplete(emptySideSpec()));
  check('完整条件可启动', specComplete(job.sides.A.spec));

  // 条件指纹：稳定、且任一条件变化都改变指纹
  const h0 = sideSpecHash(job, job.sides.A.spec);
  check('条件指纹稳定且为 16 位 hex', h0.length === 16 && h0 === sideSpecHash(job, job.sides.A.spec));
  check('指纹随渲染意图变化', sideSpecHash(job, { ...job.sides.A.spec, intent: 'perceptual' }) !== h0);
  check('指纹随 BPC 变化', sideSpecHash(job, { ...job.sides.A.spec, blackPointCompensation: false }) !== h0);
  check('指纹随软打样意图变化', sideSpecHash(job, { ...job.sides.A.spec, proofIntent: 'absolute-colorimetric' }) !== h0);
  check('指纹随目标配置变化', sideSpecHash(job, job.sides.B.spec) !== h0);
  const job2 = mkJob();
  job2.image.hash = fnv1a64(new Uint8Array([9, 9, 9]));
  check('指纹随原稿变化', sideSpecHash(job2, job2.sides.A.spec) !== h0);

  // 侧状态派生：empty -> pending -> done -> stale
  const j3 = mkJob();
  j3.sides.A.spec = emptySideSpec();
  check('未配置侧 = empty', sideDisplayStatus(j3, 'A') === 'empty');
  check('配置未运行 = pending', sideDisplayStatus(j3, 'B') === 'pending');
  const hB = sideSpecHash(j3, j3.sides.B.spec);
  j3.sides.B.result = { status: 'done', runVersion: 1, specHash: hB, width: 12, height: 8, completedAt: 't' };
  check('结果匹配当前条件 = done', sideDisplayStatus(j3, 'B') === 'done');
  j3.sides.B.spec = { ...j3.sides.B.spec, intent: 'saturation' };
  check('条件修改后旧结果 = stale', sideDisplayStatus(j3, 'B') === 'stale');
  j3.sides.B.runningVersion = 2;
  check('在途分派 = running', sideDisplayStatus(j3, 'B') === 'running');

  // 作业状态机
  const j4 = mkJob();
  check('初始 = draft', deriveJobStatus(j4) === 'draft');
  j4.sides.A.runningVersion = 1;
  check('一侧在途 = running', deriveJobStatus(j4) === 'running');
  j4.sides.A.runningVersion = null;
  j4.sides.A.result = { status: 'done', runVersion: 1, specHash: sideSpecHash(j4, j4.sides.A.spec), width: 1, height: 1, completedAt: 't' };
  check('一侧完成 = partial', deriveJobStatus(j4) === 'partial');
  j4.sides.B.result = { status: 'failed', runVersion: 1, specHash: sideSpecHash(j4, j4.sides.B.spec), width: 0, height: 0, error: 'bad icc', completedAt: 't' };
  check('一侧完成一侧失败 = partial', deriveJobStatus(j4) === 'partial');
  j4.sides.A.result = { status: 'failed', runVersion: 1, specHash: sideSpecHash(j4, j4.sides.A.spec), width: 0, height: 0, error: 'x', completedAt: 't' };
  check('两侧失败 = failed', deriveJobStatus(j4) === 'failed');
  j4.sides.A.result = { status: 'done', runVersion: 1, specHash: sideSpecHash(j4, j4.sides.A.spec), width: 1, height: 1, completedAt: 't' };
  j4.sides.B.result = { status: 'done', runVersion: 1, specHash: sideSpecHash(j4, j4.sides.B.spec), width: 1, height: 1, completedAt: 't' };
  check('两侧完成 = done', deriveJobStatus(j4) === 'done');
  j4.sides.B.spec = { ...j4.sides.B.spec, blackPointCompensation: false };
  check('一侧过期后 = partial（另一侧完成保留）', deriveJobStatus(j4) === 'partial');

  // 网格取样点：图内、去重
  const pts = gridPoints(4, 3, 5);
  check('网格点在图内且去重', pts.length > 0 && pts.every((p) => p.x >= 0 && p.x < 4 && p.y >= 0 && p.y < 3) && new Set(pts.map((p) => `${p.x},${p.y}`)).size === pts.length);

  // 摘要统计
  const mkInfo = (lab: [number, number, number]): SampleInfo => ({
    sourceDevice: [0, 0, 0],
    sourceLab: [0, 0, 0],
    targetDevice: [0, 0, 0],
    targetLab: lab,
    alpha8: 255,
    sourceColorSpace: 'RGB',
    targetColorSpace: 'RGB',
  });
  const sm = summarizeSamples(
    [{ x: 1, y: 1 }, { x: 2, y: 2 }],
    [mkInfo([50, 0, 0]), mkInfo([10, 0, 0])],
    [mkInfo([50, 0, 0]), mkInfo([90, 0, 0])],
    'hA',
    'hB',
    '2026-01-02T00:00:00Z',
  );
  check('摘要 max 定位到差异点', sm.samples === 2 && sm.maxX === 2 && sm.maxY === 2 && sm.maxDE > 50 && sm.meanDE > 25, JSON.stringify(sm));
  check('摘要阈值计数', sm.over2 === 1 && sm.over5 === 1);

  // 导出记录：两侧指纹 + 比较时间
  const j5 = mkJob();
  j5.summary = sm;
  j5.summary.specHashA = sideSpecHash(j5, j5.sides.A.spec);
  j5.summary.specHashB = sideSpecHash(j5, j5.sides.B.spec);
  const rec = buildCompareRecord(j5, '2026-01-03T00:00:00Z');
  check(
    '记录含两侧条件指纹',
    typeof rec.sides.A.specFingerprint === 'string' &&
      rec.sides.A.specFingerprint.length === 16 &&
      typeof rec.sides.B.specFingerprint === 'string' &&
      rec.sides.A.specFingerprint !== rec.sides.B.specFingerprint,
  );
  check('记录含比较时间与配置哈希', rec.comparedAt === '2026-01-02T00:00:00Z' && rec.sides.A.target.profileHash.length === 16 && rec.image.pixelHash.length === 16);
  check('记录含原稿/源指纹与免责声明', rec.source.profileHash.length === 16 && rec.disclaimer.length > 10);
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL NODE TESTS PASSED');
process.exit(failures ? 1 : 0);