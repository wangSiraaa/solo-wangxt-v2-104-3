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
  makeSideConfig,
  refreshSideFingerprint,
  effectiveSideStatus,
  deriveJobStatus,
  shouldAcceptResult,
  gridPoints,
  computePixelSummary,
  summarizeGrid,
  summaryStale,
  pinSideStale,
  comparisonTimeOf,
  buildCompareRecord,
  emptySide,
  COMPARE_RECORD_FORMAT,
  type StoredCompareJob,
  type CompareSideConfig,
} from '../src/lib/compare/model';
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

console.log('# compare model (打样条件对比)');
{
  const profA = { id: 'pA', description: 'Press A', colorSpace: 'RGB' as const, bytes: new Uint8Array([1, 2, 3, 4, 5, 6]) };
  const profB = { id: 'pB', description: 'Press B', colorSpace: 'CMYK' as const, bytes: new Uint8Array([9, 8, 7, 6]) };
  const paramsA = { intent: 'relative-colorimetric' as const, blackPointCompensation: true, proofIntent: 'relative-colorimetric' as const };
  const paramsB = { intent: 'perceptual' as const, blackPointCompensation: false, proofIntent: 'absolute-colorimetric' as const };
  const cfgA = makeSideConfig(profA, paramsA);
  const cfgB = makeSideConfig(profB, paramsB);

  check('side fingerprint is hex16', /^[0-9a-f]{16}$/.test(cfgA.fingerprint) && /^[0-9a-f]{16}$/.test(cfgB.fingerprint));
  check('two conditions have distinguishable fingerprints', cfgA.fingerprint !== cfgB.fingerprint);
  check('fingerprint stable for identical snapshot', makeSideConfig(profA, paramsA).fingerprint === cfgA.fingerprint);
  check(
    'fingerprint changes with intent / bpc / proofIntent',
    makeSideConfig(profA, { ...paramsA, intent: 'saturation' }).fingerprint !== cfgA.fingerprint &&
      makeSideConfig(profA, { ...paramsA, blackPointCompensation: false }).fingerprint !== cfgA.fingerprint &&
      makeSideConfig(profA, { ...paramsA, proofIntent: 'perceptual' }).fingerprint !== cfgA.fingerprint,
  );
  // frozen snapshot: mutating the library bytes afterwards must not change the snapshot
  const before = cfgA.profileFingerprint;
  profA.bytes[0] = 99;
  check('side config bytes are frozen copies', cfgA.profileBytes[0] === 1 && cfgA.profileFingerprint === before);
  profA.bytes[0] = 1;

  // --- job fixture ---
  const mkJob = (): StoredCompareJob => ({
    id: 'cmp-test',
    name: 't',
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    status: 'draft',
    image: { bytes: new Uint8Array([1, 2, 3]), name: 'img.png', hash: fnv1a64(new Uint8Array([1, 2, 3])), container: 'png', bitDepth: 8 },
    source: {
      profileBytes: new Uint8Array([4, 5, 6]),
      description: 'src',
      fingerprint: fnv1a64(new Uint8Array([4, 5, 6])),
      colorSpace: 'RGB',
      origin: 'embedded',
    },
    sides: { A: emptySide(), B: emptySide() },
    summary: null,
    summaryToken: '',
    pins: [],
  });
  const doneWith = (cfg: CompareSideConfig) => ({
    softProofRGBA: new Uint8Array(4),
    width: 1,
    height: 1,
    targetColorSpace: cfg.colorSpace,
    completedAt: '2026-10-02T01:00:00.000Z',
    configFingerprint: cfg.fingerprint,
    runToken: 'r1',
  });

  const job = mkJob();
  check('fresh job is draft', deriveJobStatus(job) === 'draft');
  job.sides.A.config = cfgA;
  job.sides.B.config = cfgB;
  check('configured but unrun job stays draft', deriveJobStatus(job) === 'draft');

  // run-token attribution
  job.sides.A.running = true;
  job.sides.A.runToken = 'tok-1';
  check('job running while a side runs', deriveJobStatus(job) === 'running');
  check('accepts result of the current run token', shouldAcceptResult(job.sides.A, 'tok-1'));
  check('rejects stale token (condition edited / cancelled / reopened)', !shouldAcceptResult(job.sides.A, 'tok-0'));
  job.sides.A.runToken = 'tok-2'; // 修改条件/取消 => 旧 token 作废
  check('old token discarded after bump', !shouldAcceptResult(job.sides.A, 'tok-1') && shouldAcceptResult(job.sides.A, 'tok-2'));
  job.sides.A.running = false;
  check('not accepted once no longer running', !shouldAcceptResult(job.sides.A, 'tok-2'));

  // A done, B untouched -> partial; B stale keeps A's result valid
  job.sides.A.result = doneWith(cfgA);
  check('one side done => partial', deriveJobStatus(job) === 'partial');
  job.sides.B.config = { ...cfgB, intent: 'saturation' };
  refreshSideFingerprint(job.sides.B.config);
  job.sides.B.result = doneWith(cfgB); // 旧 B 结果（指纹是旧条件的）
  check('edited side reads stale', effectiveSideStatus(job.sides.B) === 'stale');
  check('untouched side stays done', effectiveSideStatus(job.sides.A) === 'done');
  check('A done + B stale => still partial', deriveJobStatus(job) === 'partial');

  // B re-run with the new config -> complete
  job.sides.B.result = { ...doneWith(job.sides.B.config), configFingerprint: job.sides.B.config.fingerprint };
  check('both current => complete', deriveJobStatus(job) === 'complete');

  // failure evidence: broken side fails, other side keeps its result
  const jobF = mkJob();
  jobF.sides.A.config = cfgA;
  jobF.sides.B.config = cfgB;
  jobF.sides.A.result = doneWith(cfgA);
  jobF.sides.B.error = 'LittleCMS 无法打开配置文件：B';
  jobF.sides.B.failedAt = '2026-10-02T01:05:00.000Z';
  check('failed side reads failed', effectiveSideStatus(jobF.sides.B) === 'failed');
  check('A result survives B failure (partial)', deriveJobStatus(jobF) === 'partial' && effectiveSideStatus(jobF.sides.A) === 'done');
  const jobFF = mkJob();
  jobFF.sides.A.config = cfgA;
  jobFF.sides.A.error = 'x';
  check('no results + failure => failed job', deriveJobStatus(jobFF) === 'failed');

  // pixel summary
  const img1 = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]);
  const img2 = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]);
  const ps0 = computePixelSummary(img1, img2, 2, 2);
  check('identical previews: zero differing pixels', ps0.differ === 0 && ps0.maxAbs === 0 && ps0.meanAbs === 0);
  const img3 = img2.slice();
  img3[2 * 4 + 1] = 200; // pixel (0,1): G 80 -> 200
  const ps1 = computePixelSummary(img1, img3, 2, 2);
  check('diff located at the right pixel', ps1.differ === 1 && ps1.maxAbs === 120 && ps1.maxAt.x === 0 && ps1.maxAt.y === 1, JSON.stringify(ps1));

  // grid points stay in bounds
  const gp = gridPoints(12, 8, 8);
  check('grid points in bounds & non-empty', gp.length === 64 && gp.every((p) => p.x >= 0 && p.x < 12 && p.y >= 0 && p.y < 8));
  check('grid clamps to image size', gridPoints(3, 2, 8).length === 6);

  // lab grid summary from fabricated samples
  const mkInfo = (lab: [number, number, number]): SampleInfo => ({
    sourceDevice: [0, 0, 0],
    sourceLab: lab,
    targetDevice: [0, 0, 0],
    targetLab: lab,
    alpha8: 255,
    sourceColorSpace: 'RGB',
    targetColorSpace: 'RGB',
  });
  const gs = summarizeGrid([
    { x: 0, y: 0, a: mkInfo([50, 0, 0]), b: mkInfo([50, 0, 0]) },
    { x: 1, y: 0, a: mkInfo([50, 0, 0]), b: mkInfo([60, 0, 0]) },
    { x: 2, y: 0, a: null, b: mkInfo([1, 1, 1]) }, // 一侧失败：跳过
  ]);
  check('grid summary skips failed side pairs', !!gs && gs.points === 2 && gs.maxDE00 > 9 && gs.maxDE00 < 10 && gs.maxAt.x === 1, JSON.stringify(gs));
  check('grid summary null when no valid pairs', summarizeGrid([{ x: 0, y: 0, a: null, b: null }]) === null);

  // summary / pin staleness
  const jobS = mkJob();
  jobS.sides.A.config = cfgA;
  jobS.sides.B.config = cfgB;
  jobS.summary = {
    computedAt: '2026-10-02T02:00:00.000Z',
    aFingerprint: cfgA.fingerprint,
    bFingerprint: cfgB.fingerprint,
    pixel: ps0,
    lab: gs,
  };
  check('summary current when fingerprints match', !summaryStale(jobS));
  jobS.sides.B.config = { ...cfgB, blackPointCompensation: true };
  refreshSideFingerprint(jobS.sides.B.config);
  check('summary stale after condition edit', summaryStale(jobS));
  const pin = { x: 1, y: 1, a: null, b: null, aFingerprint: cfgA.fingerprint, bFingerprint: cfgB.fingerprint, pending: false };
  check('pin side A still valid', !pinSideStale(pin, jobS.sides.A, 'A'));
  check('pin side B stale after edit', pinSideStale(pin, jobS.sides.B, 'B'));

  // export record: both fingerprints + comparison time
  const jobR = mkJob();
  jobR.sides.A.config = cfgA;
  jobR.sides.B.config = cfgB;
  jobR.sides.A.result = doneWith(cfgA);
  jobR.sides.B.result = doneWith(cfgB);
  jobR.summary = {
    computedAt: '2026-10-02T03:00:00.000Z',
    aFingerprint: cfgA.fingerprint,
    bFingerprint: cfgB.fingerprint,
    pixel: ps1,
    lab: gs,
  };
  jobR.pins.push({ x: 2, y: 3, a: mkInfo([40, 1, 1]), b: mkInfo([44, 2, 2]), aFingerprint: cfgA.fingerprint, bFingerprint: cfgB.fingerprint, pending: false });
  const rec = buildCompareRecord(jobR, '2026-10-02T04:00:00.000Z', '0.1.0');
  check('record format marker', rec.recordFormat === COMPARE_RECORD_FORMAT);
  check('record carries BOTH side fingerprints', rec.sides.A.fingerprint === cfgA.fingerprint && rec.sides.B.fingerprint === cfgB.fingerprint && rec.sides.A.fingerprint !== rec.sides.B.fingerprint);
  check('record carries comparison time', rec.comparisonTime === '2026-10-02T03:00:00.000Z', rec.comparisonTime);
  check('record carries image hash + source fingerprint', rec.image.hash === jobR.image.hash && rec.source.fingerprint === jobR.source.fingerprint);
  check('record pin has cross-side dE00', rec.pins.length === 1 && rec.pins[0].deltaE00 !== null && rec.pins[0].deltaE00 > 0);
  check('record declares side independence', rec.independence.includes('原始像素'));
  check('comparison time falls back to latest side completion', comparisonTimeOf(mkJob()) === '2026-10-02T00:00:00.000Z');
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL NODE TESTS PASSED');
process.exit(failures ? 1 : 0);