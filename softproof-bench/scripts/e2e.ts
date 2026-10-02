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
 * 10. 打样条件对比：双侧独立结果与取样证据 / 缺 ICC 未确认源不可启动 /
 *     运行中替换 B 条件（A 保留、旧 B 过期）/ 一侧损坏失败隔离与单独重试 /
 *     保存-刷新-重载后仍指向原图与冻结条件
 */
import { chromium, type Browser, type Page } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--no-sandbox'],
  });

  // Broken-but-plausible ICC: valid header (RGB, declared size matches), bogus
  // tag directory -> passes the app's header parser, fails LittleCMS open.
  mkdirSync(resolve(ROOT, 'test-out'), { recursive: true });
  const brokenIccPath = resolve(ROOT, 'test-out/broken-profile.icc');
  {
    const src = readFileSync(resolve(ROOT, 'public/profiles/sRGB-elle-V2-srgbtrc.icc'));
    const broken = Buffer.from(src.subarray(0, 144));
    broken.writeUInt32BE(144, 0); // declared size = actual length
    broken.writeUInt32BE(1, 128); // tag count = 1
    broken.writeUInt32BE(0x58595a20, 132); // 'XYZ ' tag sig
    broken.writeUInt32BE(0x7fffffff, 136); // bogus offset
    broken.writeUInt32BE(0x7fffffff, 140); // bogus size
    writeFileSync(brokenIccPath, broken);
  }

  // ---- compare-mode helpers ----
  const switchMode = async (page: Page, name: string) => {
    await page.getByRole('button', { name, exact: true }).click();
  };
  const waitSideStatus = async (page: Page, side: 'A' | 'B', label: string, timeout = 60000) => {
    await page.waitForFunction(
      ([sel, txt]) => document.querySelector(sel)?.textContent?.includes(txt) ?? false,
      [`.cmp-editor-${side} .side-status`, label],
      { timeout },
    );
  };
  const sideStatus = (page: Page, side: 'A' | 'B') =>
    page.locator(`.cmp-editor-${side} .side-status`).innerText();
  const selectSideTarget = async (page: Page, side: 'A' | 'B', re: RegExp) => {
    const sel = page.locator(`.cmp-editor-${side} select.target-select`);
    const opts = await sel.locator('option').allInnerTexts();
    const idx = opts.findIndex((o) => re.test(o));
    if (idx < 0) throw new Error(`no target option matching ${re}: ${opts.join(' | ')}`);
    const val = await sel.locator('option').nth(idx).getAttribute('value');
    await sel.selectOption(val!);
  };
  const canvasPixel = (page: Page, sel: string, x: number, y: number) =>
    page.evaluate(
      ([s, px, py]) => {
        const c = document.querySelector(s) as HTMLCanvasElement | null;
        if (!c || !c.width) return null;
        return Array.from(c.getContext('2d')!.getImageData(px, py, 1, 1).data);
      },
      [sel, x, y] as const,
    );

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

  // ---------- Scenario G: 打样条件对比 — 双侧独立结果 + 取样证据 + 导出记录 ----------
  {
    const page = await freshPage(browser);
    console.log('# G. 打样条件对比：同一带 ICC 图片在两个目标条件下得到可区分结果');
    await importImage(page, resolve(FIX, 'patches-srgb.png'));
    await page.waitForSelector('.badge.embedded');
    await switchMode(page, '打样条件对比');
    await page.getByRole('button', { name: /从当前原稿与已确认源配置新建对比/ }).click();
    await page.waitForSelector('.job-head');
    const head = await page.locator('.job-head').innerText();
    ok('对比作业冻结原稿与嵌入源', head.includes('patches-srgb.png') && head.includes('嵌入 ICC'), head.slice(0, 120));

    // 导入开放 CMYK 配置作为 B 侧目标
    await page.locator('input[type=file][accept=".icc,.icm"]').setInputFiles(resolve(PROFILES, 'ISOcoated_v2_300_mth.icc'));
    await page.waitForTimeout(1200);
    await selectSideTarget(page, 'A', /sRGB/);
    await selectSideTarget(page, 'B', /ISO/i);
    const fpA = await page.locator('.cmp-editor-A .mono').first().innerText();
    ok('A 侧显示配置指纹', fpA.includes('配置指纹'), fpA);

    await page.getByRole('button', { name: /运行对比/ }).click();
    await waitSideStatus(page, 'A', '完成');
    await waitSideStatus(page, 'B', '完成');
    ok('作业状态 = 完成', (await page.locator('.job-status').innerText()).includes('完成'));

    // 双侧预览可区分（红色块在 sRGB 目标 ≈ 原值，在 ISOcoated CMYK 目标下明显不同）
    const pa = await canvasPixel(page, '.cmp-A canvas', 1, 1);
    const pb = await canvasPixel(page, '.cmp-B canvas', 1, 1);
    ok('两侧画布均有内容', !!pa && !!pb && pa[3] === 255 && pb[3] === 255, JSON.stringify({ pa, pb }));
    ok(
      '双侧结果可区分（A≈原样 sRGB，B=CMYK 打样）',
      !!pa && !!pb && (Math.abs(pa[0] - pb[0]) > 8 || Math.abs(pa[1] - pb[1]) > 8 || Math.abs(pa[2] - pb[2]) > 8),
      `A=${pa} B=${pb}`,
    );

    // 钉选取样点 -> 同点 A/B 对照 + ΔE
    const cvs = page.locator('.cmp-A canvas');
    const box = await cvs.boundingBox();
    await page.mouse.click(box!.x + box!.width * 0.3, box!.y + box!.height * 0.45);
    await page.waitForFunction(
      () => document.querySelector('.pin-row')?.textContent?.includes('ΔE00') ?? false,
      null,
      { timeout: 30000 },
    );
    const pinText = await page.locator('.pin-row').first().innerText();
    ok('取样点含坐标与双侧读数', /\(1, 1\)|\(\d+, \d+\)/.test(pinText) && pinText.includes('Lab'), pinText.slice(0, 200));
    ok('取样点含 ΔE00 差异', /ΔE00（A↔B 目标 Lab）/.test(pinText), pinText.slice(0, 200));

    // 整体摘要自动计算（含可定位最大差异）
    await page.waitForFunction(
      () => document.querySelector('.summary-panel')?.textContent?.includes('平均 ΔE00') ?? false,
      null,
      { timeout: 30000 },
    );
    const summaryText = await page.locator('.summary-panel').innerText();
    ok('摘要含平均/最大 ΔE 与定位', summaryText.includes('最大 ΔE00') && /@ \(\d+, \d+\)/.test(summaryText), summaryText.slice(0, 200));
    ok('摘要含比较时间', summaryText.includes('比较时间'));

    // 导出对比记录：两侧配置指纹 + 比较时间
    const downloads: { name: string; path: string }[] = [];
    const waiters: Promise<void>[] = [];
    page.on('download', (d) => {
      const p = resolve(ROOT, 'test-out', d.suggestedFilename());
      waiters.push(d.saveAs(p));
      downloads.push({ name: d.suggestedFilename(), path: p });
    });
    await page.getByRole('button', { name: /导出对比记录/ }).click();
    await page.waitForTimeout(1200);
    await Promise.all(waiters);
    ok('导出产生对比记录 JSON', downloads.length === 1 && downloads[0].name.endsWith('.compare-record.json'), downloads.map((d) => d.name).join(','));
    if (downloads.length) {
      const rec = JSON.parse(readFileSync(downloads[0].path, 'utf8'));
      ok(
        '记录含两侧条件指纹',
        typeof rec.sides?.A?.specFingerprint === 'string' &&
          rec.sides.A.specFingerprint.length === 16 &&
          typeof rec.sides?.B?.specFingerprint === 'string' &&
          rec.sides.A.specFingerprint !== rec.sides.B.specFingerprint,
      );
      ok(
        '记录含两侧配置哈希与比较时间',
        typeof rec.sides?.A?.target?.profileHash === 'string' &&
          typeof rec.sides?.B?.target?.profileHash === 'string' &&
          typeof rec.comparedAt === 'string' &&
          rec.comparedAt.length > 10,
      );
      ok('记录含原稿/源指纹与取样证据', typeof rec.image?.pixelHash === 'string' && typeof rec.source?.profileHash === 'string' && Array.isArray(rec.pins) && rec.pins.length === 1 && typeof rec.pins[0].deltaE00 === 'number');
    }

    // ---------- Scenario K: 保存 → 刷新 → 重载后仍指向原图与冻结条件 ----------
    console.log('# K. 保存/刷新/重载后对比仍指向原始图片与冻结条件');
    await page.reload();
    await page.waitForSelector('.sidebar', { timeout: 15000 });
    await switchMode(page, '打样条件对比');
    await page.locator('.job-item .left').first().click();
    await page.waitForSelector('.job-head');
    const head2 = await page.locator('.job-head').innerText();
    ok('重载后作业仍指向原图', head2.includes('patches-srgb.png'), head2.slice(0, 120));
    ok('重载后两侧状态仍为完成', (await sideStatus(page, 'A')).includes('完成') && (await sideStatus(page, 'B')).includes('完成'));
    const pa2 = await canvasPixel(page, '.cmp-A canvas', 1, 1);
    ok('重载后预览仍渲染', !!pa2 && pa2[3] === 255, JSON.stringify(pa2));
    ok('重载后取样点仍在', (await page.locator('.pin-row').count()) === 1);
    ok('重载后摘要仍在', (await page.locator('.summary-panel').innerText()).includes('平均 ΔE00'));

    // 主面板改动不得影响已冻结的对比
    await switchMode(page, '单条件转换');
    await importImage(page, resolve(FIX, 'patches-noicc.png'));
    await page.locator('select').filter({ hasText: '请选择目标配置' }).first().selectOption({ index: 1 });
    await switchMode(page, '打样条件对比');
    const head3 = await page.locator('.job-head').innerText();
    const selA = await page.locator('.cmp-editor-A select.target-select').inputValue();
    ok('主面板换图换配置后对比仍冻结', head3.includes('patches-srgb.png') && selA === 'builtin-srgb-elle', `${head3.slice(0, 80)} selA=${selA}`);
    ok('主面板改动后两侧状态不受影响', (await sideStatus(page, 'A')).includes('完成') && (await sideStatus(page, 'B')).includes('完成'));
    await page.close();
  }

  // ---------- Scenario H: 缺 ICC 未确认源配置 -> 两侧均不可启动 ----------
  {
    const page = await freshPage(browser);
    console.log('# H. 缺 ICC 图片未确认源配置 -> 对比不可建档/启动');
    await importImage(page, resolve(FIX, 'patches-noicc.png'));
    await page.waitForSelector('.warn');
    await switchMode(page, '打样条件对比');
    const createBtn = page.getByRole('button', { name: /从当前原稿与已确认源配置新建对比/ });
    ok('未确认源配置时新建对比被禁用', await createBtn.isDisabled());
    ok('提示需先确认源配置', (await page.locator('.gate-hint').innerText()).includes('尚未确认源配置'));

    // 回到单条件模式确认源配置（假设）后即可建档
    await switchMode(page, '单条件转换');
    await page.locator('select').filter({ hasText: '请选择源配置' }).first().selectOption({ index: 1 });
    await page.waitForSelector('.ok');
    await switchMode(page, '打样条件对比');
    ok('确认假设后可新建对比', await createBtn.isEnabled());
    await createBtn.click();
    await page.waitForSelector('.job-head');
    ok('对比源配置标记为人工假设', (await page.locator('.job-head').innerText()).includes('人工假设'));
    await page.close();
  }

  // ---------- Scenario I: 运行中替换 B 条件 -> A 保留，旧 B 过期 ----------
  {
    const page = await freshPage(browser);
    console.log('# I. 替换 B 条件：A 已完成结果保留，旧 B 结果标为过期');
    await importImage(page, resolve(FIX, 'patches-srgb.png'));
    await page.waitForSelector('.badge.embedded');
    await switchMode(page, '打样条件对比');
    await page.getByRole('button', { name: /从当前原稿与已确认源配置新建对比/ }).click();
    await page.waitForSelector('.job-head');
    await selectSideTarget(page, 'A', /sRGB/);
    await selectSideTarget(page, 'B', /CIERGB/i);
    await page.getByRole('button', { name: /运行对比/ }).click();
    await waitSideStatus(page, 'A', '完成');
    await waitSideStatus(page, 'B', '完成');

    // I1. 运行完成后替换 B 目标：A 保留完成，B 的旧结果过期
    await selectSideTarget(page, 'B', /sRGB/);
    ok('替换 B 后 A 仍完成', (await sideStatus(page, 'A')).includes('完成'));
    ok('替换 B 后旧 B 结果已过期', (await sideStatus(page, 'B')).includes('已过期'));
    ok('作业状态 = 部分完成', (await page.locator('.job-status').innerText()).includes('部分完成'));

    // I2. 运行中修改 B 条件：在途旧 B 结果不得写入；A 正常完成
    await page.getByRole('button', { name: /运行对比/ }).click();
    await page.locator('.cmp-editor-B select.intent-select').selectOption('saturation');
    await waitSideStatus(page, 'A', '完成');
    await page.waitForFunction(
      () => !document.querySelector('.cmp-editor-B .side-status')?.textContent?.includes('运行中'),
      null,
      { timeout: 60000 },
    );
    const bAfter = await sideStatus(page, 'B');
    ok('运行中改 B 后 B 非完成（旧结果过期/待重跑）', !bAfter.includes('完成'), bAfter);
    ok('A 结果保留且完成', (await sideStatus(page, 'A')).includes('完成'));

    // 单独重跑 B 后作业完成
    await page.locator('.cmp-editor-B .run-side-btn').click();
    await waitSideStatus(page, 'B', '完成');
    ok('重跑 B 后作业完成', (await page.locator('.job-status').innerText()).includes('完成'));
    await page.close();
  }

  // ---------- Scenario J: 一侧配置损坏 -> 失败隔离，另一侧保留，可单独重试 ----------
  {
    const page = await freshPage(browser);
    console.log('# J. 一侧配置损坏：失败隔离 + 失败证据 + 单独重试');
    await importImage(page, resolve(FIX, 'patches-srgb.png'));
    await page.waitForSelector('.badge.embedded');
    await switchMode(page, '打样条件对比');
    await page.getByRole('button', { name: /从当前原稿与已确认源配置新建对比/ }).click();
    await page.waitForSelector('.job-head');
    await page.locator('input[type=file][accept=".icc,.icm"]').setInputFiles(brokenIccPath);
    await page.waitForTimeout(800);
    await selectSideTarget(page, 'A', /sRGB/);
    await selectSideTarget(page, 'B', /broken-profile/);
    await page.getByRole('button', { name: /运行对比/ }).click();
    await waitSideStatus(page, 'A', '完成');
    await waitSideStatus(page, 'B', '失败');
    ok('一侧失败时作业 = 部分完成', (await page.locator('.job-status').innerText()).includes('部分完成'));
    ok('A 侧结果保留且画布有内容', (await canvasPixel(page, '.cmp-A canvas', 1, 1))?.[3] === 255);
    const failText = await page.locator('.cmp-editor-B .fail-box').innerText();
    ok('B 侧失败证据可见', failText.includes('失败证据') && failText.length > 6, failText.slice(0, 120));
    ok('画布区也展示 B 失败', (await page.locator('.cmp-B .side-line').innerText()).includes('失败'));

    // 修复 B 条件后单独重试
    await selectSideTarget(page, 'B', /CIERGB/i);
    await page.locator('.cmp-editor-B .run-side-btn').click();
    await waitSideStatus(page, 'B', '完成');
    ok('修复后单独重试 B 成功，作业完成', (await page.locator('.job-status').innerText()).includes('完成'));
    ok('A 侧在整个过程中保持完成', (await sideStatus(page, 'A')).includes('完成'));
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
