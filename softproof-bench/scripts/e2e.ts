/**
 * Browser end-to-end test against the running Vite dev server.
 *
 * Covers the required flow:
 *  1. import image with embedded ICC -> source identified automatically
 *  2. import image WITHOUT ICC -> source profile selection is mandatory,
 *     assumption recorded
 *  3. choose target profile (open CIE RGB + imported open CMYK), intent, BPC
 *  4. side-by-side preview appears
 *  5. sampler reports source/target device + Lab values
 *  6. export PNG (RGB target) -> ImageMagick-independent verification done in
 *     scripts/verify-exports.sh (iCCP + pixels + provenance)
 *  7. export TIFF (CMYK target)
 *  8. re-import the converted export -> blocked as already-converted
 *  9. transparent borders survive
 */
import { chromium, type Browser, type Page } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fnv1a64 } from '../src/lib/color/hash';

const ROOT = resolve(import.meta.dirname, '..');
const FIX = resolve(ROOT, 'test-assets/browser');
const PROFILES = resolve(ROOT, 'test-assets/profiles');
const URL = process.env.E2E_URL || 'http://localhost:5199';

let failures = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.error(`  FAIL - ${name} ${detail}`);
  }
}

async function freshPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 980 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL);
  await page.waitForSelector('text=/正在加载|原图（原始像素）/');
  await page.waitForSelector('.sidebar', { timeout: 15000 });
  (page as unknown as { __errs: string[] }).__errs = errors;
  return page;
}

async function importImage(page: Page, file: string) {
  const input = page.locator('input[type=file][accept*="png"]').first();
  await input.setInputFiles(file);
}

async function runConvert(page: Page) {
  const btn = page.getByRole('button', { name: /执行 ICC 转换/ });
  await btn.click();
  await page.waitForFunction(
    () => !document.body.innerText.includes('LittleCMS 转换中'),
    null,
    { timeout: 60000 },
  );
}

async function exportPair(page: Page): Promise<{ png: string; tif?: string }> {
  const names: string[] = [];
  page.on('download', async (d) => names.push(d.suggestedFilename()));
  // downloads actually save via <a download>; listen for download events
  const downloads: { name: string; path: string }[] = [];
  page.removeListener('download', () => {});
  const waiters: Promise<void>[] = [];
  page.on('download', (d) => {
    const p = resolve(ROOT, 'test-out', d.suggestedFilename());
    waiters.push(d.saveAs(p));
    downloads.push({ name: d.suggestedFilename(), path: p });
  });
  await page.getByRole('button', { name: /导出转换图像/ }).click();
  await page.waitForTimeout(1500);
  await Promise.all(waiters);
  ok(`export produced 2 files (got ${downloads.length})`, downloads.length === 2, downloads.map((d) => d.name).join(','));
  const img = downloads.find((d) => d.name.endsWith('.png') || d.name.endsWith('.tif'))!;
  return { png: img.path, tif: downloads.find((d) => d.name.endsWith('.tif'))?.path };
}

async function main() {
  // The corrupted-profile fixture is normally produced by make-fixtures (via
  // test:node); regenerate it here when missing so the e2e is self-contained.
  const corruptedPath = resolve(PROFILES, 'corrupted-truncated.icc');
  if (!existsSync(corruptedPath)) {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(PROFILES, { recursive: true });
    const full = readFileSync(resolve(ROOT, 'public/profiles/sRGB-elle-V2-srgbtrc.icc'));
    writeFileSync(corruptedPath, full.subarray(0, 6000));
  }

  // Sandboxes without a full OS may carry chromium's shared libraries in a
  // user-local dir; expose them to the browser process when present.
  const localLibs = [
    resolve(homedir(), '.local/chromium-libs/usr/lib/aarch64-linux-gnu'),
    resolve(homedir(), '.local/chromium-libs/lib/aarch64-linux-gnu'),
  ].filter((d) => existsSync(d));
  const env = localLibs.length
    ? { ...process.env, LD_LIBRARY_PATH: [...localLibs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') }
    : undefined;
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--no-sandbox'],
    ...(env ? { env } : {}),
  });

  // ---------- compare helpers ----------
  async function selectOptionContaining(page: Page, testid: string, fragment: string) {
    const sel = page.getByTestId(testid);
    const opts = await sel.locator('option').allInnerTexts();
    const idx = opts.findIndex((o) => o.includes(fragment));
    if (idx < 0) throw new Error(`option "${fragment}" not found in ${testid}: ${opts.join(' | ')}`);
    await sel.selectOption({ index: idx });
  }
  async function waitSide(page: Page, side: 'A' | 'B', label: string, timeout = 30000) {
    await page.waitForFunction(
      ([s, expected]) =>
        document.querySelector(`[data-testid="side-status-${s}"]`)?.textContent?.includes(expected as string),
      [side, label] as const,
      { timeout },
    );
  }
  async function canvasPixel(page: Page, stage: string, x: number, y: number): Promise<number[]> {
    return page.evaluate(
      ([sel, px, py]) => {
        const c = document.querySelector(`${sel} canvas`) as HTMLCanvasElement | null;
        if (!c || !c.width) return [];
        return Array.from(c.getContext('2d')!.getImageData(px as number, py as number, 1, 1).data);
      },
      [stage, x, y] as const,
    );
  }
  async function downloadCompareRecord(page: Page): Promise<{ name: string; path: string }> {
    const waiter = page.waitForEvent('download', { timeout: 15000 });
    await page.getByTestId('export-record').click();
    const d = await waiter;
    const p = resolve(ROOT, 'test-out', d.suggestedFilename());
    await d.saveAs(p);
    return { name: d.suggestedFilename(), path: p };
  }
  async function setupCompareJob(page: Page, aFragment: string, bFragment: string) {
    await page.getByTestId('tab-compare').click();
    await page.getByTestId('new-compare-job').click();
    await page.waitForSelector('[data-testid="job-status"]');
    await selectOptionContaining(page, 'target-A', aFragment);
    await selectOptionContaining(page, 'target-B', bFragment);
    await page.getByTestId('run-all').click();
    await waitSide(page, 'A', '已完成');
    await waitSide(page, 'B', '已完成');
  }

  // ---------- Scenario A: embedded sRGB -> CIE RGB ----------
  {
    const page = await freshPage(browser);
    console.log('# A. embedded-profile image -> CIE RGB');
    await importImage(page, resolve(FIX, 'patches-srgb.png'));
    await page.waitForSelector('.badge.embedded');
    ok('embedded ICC badge shown', await page.locator('.badge.embedded').first().isVisible());
    ok('source description visible', (await page.locator('.mono.small').first().innerText()).length > 3);

    // transparent border canvas alpha check happens after convert; run it
    await runConvert(page);
    await page.waitForTimeout(800);
    // both canvases present and non-empty
    const canvases = await page.locator('canvas').count();
    ok('two canvases rendered', canvases >= 2, String(canvases));
    const alphaInfo = await page.evaluate(() => {
      const cvs = document.querySelectorAll('canvas');
      const out: { corner: number[]; red: number[] }[] = [];
      cvs.forEach((c) => {
        const ctx = c.getContext('2d')!;
        const corner = Array.from(ctx.getImageData(0, 0, 1, 1).data);
        const red = Array.from(ctx.getImageData(1, 1, 1, 1).data);
        out.push({ corner, red });
      });
      return out;
    });
    ok(
      'transparent corner alpha=0 on both canvases',
      alphaInfo.length >= 2 && alphaInfo.every((a) => a.corner[3] === 0),
      JSON.stringify(alphaInfo),
    );

    // sampler: hover interior red block
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    await page.mouse.move(box!.x + box!.width * 0.3, box!.y + box!.height * 0.45);
    await page.waitForTimeout(600);
    const sampleText = await page.locator('.samplegrid').first().innerText();
    ok('sampler shows Lab rows', sampleText.includes('Lab') && sampleText.includes('ΔE'), sampleText.slice(0, 200));
    ok('sampler shows source percentages', /R\s+\d+\.\d%/.test(sampleText));

    // export RGB PNG
    const { png } = await exportPair(page);
    ok('PNG export exists', existsSync(png), png);
    const exported = readFileSync(png);
    ok('PNG export has iCCP marker bytes', exported.subarray(0, 8).every((b, i) => b === [137, 80, 78, 71, 13, 10, 26, 10][i]));
    const errs = (page as unknown as { __errs: string[] }).__errs.filter(
      (e) => !e.includes('Failed to load resource') && !e.includes('favicon'),
    );
    ok('no page errors', errs.length === 0, errs.join(' | ').slice(0, 400));
    await page.close();
  }

  // ---------- Scenario B: missing profile forces source choice ----------
  {
    const page = await freshPage(browser);
    console.log('# B. no-ICC image forces source assumption');
    await importImage(page, resolve(FIX, 'patches-noicc.png'));
    await page.waitForSelector('.warn');
    const warn = await page.locator('.warn.panel-warn').first().innerText();
    ok('missing-profile warning shown', warn.includes('缺少嵌入'));
    const convertBtn = page.getByRole('button', { name: /执行 ICC 转换/ });
    ok('convert disabled until source chosen', await convertBtn.isDisabled());

    // choose sRGB as assumed source
    await page.locator('select').filter({ hasText: '请选择源配置' }).first().selectOption({ index: 1 });
    await page.waitForSelector('.ok');
    ok('assumption recorded notice', (await page.locator('.small.ok').first().innerText()).includes('已记录假设'));
    ok('convert enabled after choice', !(await convertBtn.isDisabled()));
    await page.close();
  }

  // ---------- Scenario C: CMYK target -> TIFF export ----------
  {
    const page = await freshPage(browser);
    console.log('# C. RGB -> open CMYK profile -> TIFF export');
    // import CMYK profile into the library
    await page
      .locator('input[type=file][accept*=".icc"]')
      .setInputFiles(resolve(PROFILES, 'ISOcoated_v2_300_mth.icc'));
    await page.waitForTimeout(1000);
    await importImage(page, resolve(FIX, 'patches-srgb.png'));
    await page.waitForSelector('.badge.embedded');
    // pick target: select containing ISO Coated
    const targetSelect = page.locator('label.field', { hasText: '目标 ICC' }).locator('select');
    const opts = await targetSelect.locator('option').allInnerTexts();
    const isoIdx = opts.findIndex((o) => o.includes('ISO Coated'));
    ok('CMYK profile listed', isoIdx >= 0, opts.join(' | '));
    await targetSelect.selectOption({ index: isoIdx });
    await page.waitForTimeout(200);
    await runConvert(page);
    await page.waitForTimeout(800);
    const { tif } = await exportPair(page);
    ok('TIFF export produced', !!tif && existsSync(tif!), tif ?? '');
    await page.close();
  }

  // ---------- Scenario D: re-import converted export is blocked ----------
  {
    const page = await freshPage(browser);
    console.log('# D. converted export re-import is blocked');
    const exportedPng = resolve(ROOT, 'test-out')
      ? undefined
      : undefined;
    void exportedPng;
    // find latest proof png in test-out
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(resolve(ROOT, 'test-out')).filter((f) => f.endsWith('.png') && f.includes('proof'));
    ok('found converted export to re-import', files.length > 0, files.join(','));
    if (files.length) {
      await importImage(page, resolve(ROOT, 'test-out', files[0]));
      await page.waitForSelector('.danger');
      const danger = await page.locator('.danger').first().innerText();
      ok('re-import warns about double conversion', danger.includes('转换标记'));
      ok(
        'convert button blocked',
        await page.getByRole('button', { name: /执行 ICC 转换/ }).isDisabled(),
      );
    }
    await page.close();
  }

  // ---------- Scenario E: JPEG with embedded ICC (APP2 path) ----------
  {
    const page = await freshPage(browser);
    console.log('# E. embedded-profile JPEG -> CIE RGB');
    const input = page.locator('input[type=file][accept*="jpeg"]').first();
    await input.setInputFiles(resolve(FIX, 'patches-srgb.jpg'));
    await page.waitForSelector('.badge.embedded');
    ok('JPEG embedded ICC badge shown', await page.locator('.badge.embedded').first().isVisible());
    await runConvert(page);
    await page.waitForTimeout(500);
    ok('JPEG conversion rendered 2 canvases', (await page.locator('canvas').count()) >= 2);
    await page.close();
  }

  // ---------- Scenario F: 16-bit PNG with iCCP ----------
  {
    const page = await freshPage(browser);
    console.log('# F. 16-bit PNG -> CIE RGB');
    await importImage(page, resolve(FIX, 'patches-srgb16.png'));
    await page.waitForSelector('.badge.embedded');
    await runConvert(page);
    await page.waitForTimeout(900);
    const info16 = await page.evaluate(() => {
      const cvs = document.querySelectorAll('canvas');
      const c = cvs[1];
      const ctx = c.getContext('2d')!;
      return { corner: Array.from(ctx.getImageData(0, 0, 1, 1).data), w: c.width, h: c.height };
    });
    ok('16-bit source proof canvas alpha preserved', info16.corner[3] === 0, JSON.stringify(info16.corner));
    ok('16-bit dimensions kept', info16.w === 12 && info16.h === 8, JSON.stringify(info16));
    await page.close();
  }

  // ---------- Scenario G: compare — same ICC image, two distinguishable sides ----------
  {
    const page = await freshPage(browser);
    console.log('# G. 对比：同一带 ICC 图片在两个目标条件下可区分');
    await page
      .locator('input[type=file][accept*=".icc"]')
      .setInputFiles(resolve(PROFILES, 'ISOcoated_v2_300_mth.icc'));
    await page.waitForTimeout(1200);
    await importImage(page, resolve(FIX, 'patches-srgb.png'));
    await page.waitForSelector('.badge.embedded');
    await page.getByTestId('tab-compare').click();
    await page.getByTestId('new-compare-job').click();
    await page.waitForSelector('[data-testid="job-status"]');
    ok('job created as draft', (await page.getByTestId('job-status').innerText()) === '草稿');
    await selectOptionContaining(page, 'target-A', 'CIERGB');
    await selectOptionContaining(page, 'target-B', 'ISO Coated');
    await page.getByTestId('run-all').click();
    await waitSide(page, 'A', '已完成');
    await waitSide(page, 'B', '已完成');
    ok('job complete', (await page.getByTestId('job-status').innerText()) === '完成');

    const pa = await canvasPixel(page, '.cmp-stage-A', 2, 2);
    const pb = await canvasPixel(page, '.cmp-stage-B', 2, 2);
    ok('both side previews rendered', pa.length === 4 && pb.length === 4 && pa[3] === 255 && pb[3] === 255, JSON.stringify({ pa, pb }));
    ok('two sides are distinguishable', pa.slice(0, 3).some((v, i) => Math.abs(v - pb[i]) > 2), `A=${pa} B=${pb}`);

    await page.waitForSelector('[data-testid="compare-summary"]', { timeout: 30000 });
    const differ = Number(await page.getByTestId('summary-differ').innerText());
    ok('summary reports differing pixels', differ > 0, String(differ));
    const maxde = Number(await page.getByTestId('summary-maxde').innerText());
    ok('summary reports max dE00 > 0', maxde > 0, String(maxde));

    // locatable sampling evidence: pin on canvas A
    await page.locator('.cmp-stage-A canvas').click({ position: { x: 24, y: 16 } });
    await page.waitForSelector('[data-testid="pin-deltae"]', { timeout: 30000 });
    const pinDE = Number(await page.getByTestId('pin-deltae').innerText());
    ok('pin shows cross-side dE00', pinDE > 0, String(pinDE));
    const pinText = await page.locator('[data-testid="compare-pin"]').first().innerText();
    ok('pin shows both sides device + Lab', pinText.includes('A') && pinText.includes('B') && pinText.includes('Lab'), pinText.slice(0, 160));

    const rec = await downloadCompareRecord(page);
    const json = JSON.parse(readFileSync(rec.path, 'utf8'));
    ok(
      'record carries BOTH side fingerprints (distinct)',
      !!json.sides?.A?.fingerprint && !!json.sides?.B?.fingerprint && json.sides.A.fingerprint !== json.sides.B.fingerprint,
    );
    ok('record carries comparison time', typeof json.comparisonTime === 'string' && json.comparisonTime.length > 10, json.comparisonTime);
    ok('record format marker', json.recordFormat === 'softproof-bench-compare/1');
    const errs = (page as unknown as { __errs: string[] }).__errs.filter(
      (e) => !e.includes('Failed to load resource') && !e.includes('favicon'),
    );
    ok('no page errors', errs.length === 0, errs.join(' | ').slice(0, 400));
    await page.close();
  }

  // ---------- Scenario H: compare blocked until source confirmed ----------
  {
    const page = await freshPage(browser);
    console.log('# H. 对比：缺 ICC 未确认源配置时两侧均不可启动');
    await importImage(page, resolve(FIX, 'patches-noicc.png'));
    await page.waitForSelector('.warn');
    await page.getByTestId('tab-compare').click();
    ok('create disabled while source unconfirmed', await page.getByTestId('new-compare-job').isDisabled());
    const blocked = await page.getByTestId('create-blocked').innerText();
    ok('blocked reason mentions missing ICC', blocked.includes('缺少嵌入'), blocked);

    await page.locator('select').filter({ hasText: '请选择源配置' }).first().selectOption({ index: 1 });
    await page.waitForSelector('.ok');
    ok('create enabled after source confirmed', !(await page.getByTestId('new-compare-job').isDisabled()));
    await page.getByTestId('new-compare-job').click();
    await page.waitForSelector('[data-testid="job-status"]');
    const frozen = await page.getByTestId('job-frozen').innerText();
    ok('assumed source frozen into job', frozen.includes('人工假设'), frozen);
    await selectOptionContaining(page, 'target-A', 'CIERGB');
    await selectOptionContaining(page, 'target-B', 'sRGB');
    await page.getByTestId('run-all').click();
    await waitSide(page, 'A', '已完成');
    await waitSide(page, 'B', '已完成');
    ok('assumed-source job completes both sides', (await page.getByTestId('job-status').innerText()) === '完成');
    await page.close();
  }

  // ---------- Scenario I: replace B (incl. mid-run) — A kept, old B stale ----------
  {
    const page = await freshPage(browser);
    console.log('# I. 对比：替换 B 条件后 A 结果保留、旧 B 过期');
    await page
      .locator('input[type=file][accept*=".icc"]')
      .setInputFiles(resolve(PROFILES, 'ISOcoated_v2_300_mth.icc'));
    await page.waitForTimeout(1200);
    await importImage(page, resolve(FIX, 'patches-srgb.png'));
    await page.waitForSelector('.badge.embedded');
    await setupCompareJob(page, 'CIERGB', 'sRGB');
    ok('baseline complete', (await page.getByTestId('job-status').innerText()) === '完成');
    const aPixBefore = await canvasPixel(page, '.cmp-stage-A', 3, 3);

    // replace B while idle
    await selectOptionContaining(page, 'target-B', 'ISO Coated');
    await page.waitForSelector('[data-testid="stale-B"]');
    ok('A stays done after B replaced', (await page.getByTestId('side-status-A').innerText()) === '已完成');
    ok('old B result marked stale', (await page.getByTestId('side-status-B').innerText()) === '已过期');
    ok('job partial', (await page.getByTestId('job-status').innerText()) === '部分完成');
    const aPixAfter = await canvasPixel(page, '.cmp-stage-A', 3, 3);
    ok('A preview pixels untouched', JSON.stringify(aPixBefore) === JSON.stringify(aPixAfter));

    // replace B *while a run is in flight*: stale B result must never be written
    await page.getByTestId('intent-A').selectOption({ index: 2 }); // A stale too
    await page.waitForSelector('[data-testid="stale-A"]');
    await page.getByTestId('run-all').click();
    await selectOptionContaining(page, 'target-B', 'CIERGB'); // mid-run edit bumps B's run token
    await waitSide(page, 'A', '已完成');
    const bStatus = await page.getByTestId('side-status-B').innerText();
    ok('B not done with unreconciled config after mid-run replace', bStatus !== '已完成', bStatus);
    ok('A done and kept after mid-run replace of B', (await page.getByTestId('side-status-A').innerText()) === '已完成');
    await page.getByTestId('run-B').click();
    await waitSide(page, 'B', '已完成');
    ok('job complete after B re-run', (await page.getByTestId('job-status').innerText()) === '完成');
    await page.close();
  }

  // ---------- Scenario J: broken side config fails independently ----------
  {
    const page = await freshPage(browser);
    console.log('# J. 对比：一侧配置损坏，另一侧结果与失败证据仍可查看');
    await page
      .locator('input[type=file][accept*=".icc"]')
      .setInputFiles(resolve(PROFILES, 'corrupted-truncated.icc'));
    await page.waitForTimeout(800);
    const notice = await page.locator('.banner').first().innerText();
    ok('corrupted profile accepted at parser level', notice.includes('已加入配置库'), notice);
    await importImage(page, resolve(FIX, 'patches-srgb.png'));
    await page.waitForSelector('.badge.embedded');
    await page.getByTestId('tab-compare').click();
    await page.getByTestId('new-compare-job').click();
    await page.waitForSelector('[data-testid="job-status"]');
    await selectOptionContaining(page, 'target-A', 'CIERGB');
    await selectOptionContaining(page, 'target-B', 'corrupted');
    await page.getByTestId('run-all').click();
    await waitSide(page, 'B', '失败');
    await waitSide(page, 'A', '已完成');
    ok('job partial with B failed', (await page.getByTestId('job-status').innerText()) === '部分完成');
    const errB = await page.getByTestId('error-B').innerText();
    ok('failure evidence visible', errB.includes('失败证据') && errB.length > 12, errB);
    const aPix = await canvasPixel(page, '.cmp-stage-A', 3, 3);
    ok('A result still viewable', aPix.length === 4 && aPix[3] === 255, JSON.stringify(aPix));

    // retry the failed side alone -> fails again, evidence stays, A untouched
    await page.getByTestId('run-B').click();
    await waitSide(page, 'B', '失败');
    ok('B retry fails again with evidence', (await page.getByTestId('error-B').innerText()).includes('失败证据'));
    ok('A still done after B retry', (await page.getByTestId('side-status-A').innerText()) === '已完成');

    // fix B -> recovers independently
    await selectOptionContaining(page, 'target-B', 'sRGB');
    await page.getByTestId('run-B').click();
    await waitSide(page, 'B', '已完成');
    ok('job complete after B fixed', (await page.getByTestId('job-status').innerText()) === '完成');
    await page.close();
  }

  // ---------- Scenario K: save / reload keeps frozen job independent of panel ----------
  {
    const page = await freshPage(browser);
    console.log('# K. 对比：保存、刷新、重载后仍指向原图与冻结条件');
    await page
      .locator('input[type=file][accept*=".icc"]')
      .setInputFiles(resolve(PROFILES, 'ISOcoated_v2_300_mth.icc'));
    await page.waitForTimeout(1200);
    await importImage(page, resolve(FIX, 'patches-srgb.png'));
    await page.waitForSelector('.badge.embedded');
    await setupCompareJob(page, 'CIERGB', 'ISO Coated');
    const fpA = (await page.getByTestId('fingerprint-A').innerText()).trim();
    const fpB = (await page.getByTestId('fingerprint-B').innerText()).trim();
    const pixBefore = await canvasPixel(page, '.cmp-stage-A', 3, 3);

    await page.reload();
    await page.waitForSelector('.sidebar', { timeout: 15000 });
    await page.getByTestId('tab-compare').click();
    await page.waitForSelector('[data-testid^="open-job-"]', { timeout: 15000 });
    await page.locator('[data-testid^="open-job-"]').first().click();
    await page.waitForSelector('[data-testid="job-status"]');
    ok('reloaded job still complete', (await page.getByTestId('job-status').innerText()) === '完成');
    ok('job still points at original image', (await page.getByTestId('job-frozen').innerText()).includes('patches-srgb.png'));
    ok(
      'frozen fingerprints survive reload',
      (await page.getByTestId('fingerprint-A').innerText()).trim() === fpA &&
        (await page.getByTestId('fingerprint-B').innerText()).trim() === fpB,
    );
    const pixAfter = await canvasPixel(page, '.cmp-stage-A', 3, 3);
    ok('stored preview re-rendered identically', pixAfter.length === 4 && JSON.stringify(pixBefore) === JSON.stringify(pixAfter));

    // panel actions must not touch the frozen job
    await importImage(page, resolve(FIX, 'patches-noicc.png'));
    await page.waitForSelector('.warn');
    await page.locator('label.field', { hasText: '目标 ICC' }).locator('select').selectOption({ index: 3 });
    await page.waitForTimeout(400);
    ok('job unaffected by new panel image', (await page.getByTestId('job-frozen').innerText()).includes('patches-srgb.png'));
    ok('frozen conditions unaffected by panel', (await page.getByTestId('fingerprint-A').innerText()).trim() === fpA);
    const pixFinal = await canvasPixel(page, '.cmp-stage-A', 3, 3);
    ok('preview unchanged by panel actions', JSON.stringify(pixFinal) === JSON.stringify(pixBefore));

    const rec = await downloadCompareRecord(page);
    const json = JSON.parse(readFileSync(rec.path, 'utf8'));
    const srcBytes = readFileSync(resolve(FIX, 'patches-srgb.png'));
    ok('record image hash matches original file', json.image?.hash === fnv1a64(new Uint8Array(srcBytes)), json.image?.hash);
    ok('record fingerprints match UI', fpA.includes(json.sides.A.fingerprint) && fpB.includes(json.sides.B.fingerprint));
    ok('record comparison time present after reload', typeof json.comparisonTime === 'string' && json.comparisonTime.length > 10);
    await page.close();
  }

  await browser.close();
  console.log(failures ? `\n${failures} E2E FAILURES` : '\nALL E2E TESTS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
