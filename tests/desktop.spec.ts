import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { Bootstrap, StatisticsResult } from '../src/types';

// These tests run the real Tauri executable, Rust commands and SQLite store.
// They never use the normal app-data directory or a real attendance device.
test.describe.serial('真实 Tauri 桌面流程', () => {
  let app: ChildProcess;
  let browser: Browser;
  let page: Page;
  let directory: string;
  const errors: string[] = [];
  const port = 19327;
  async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    return page.evaluate(({ command, args }) => (window as unknown as { __TAURI_INTERNALS__: { invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__.invoke<T>(command, args), { command, args });
  }
  test.beforeAll(async () => {
    await mkdir(resolve('.local-data'), { recursive: true });
    directory = await mkdtemp(resolve('.local-data/e2e-'));
    app = spawn(resolve(process.env.NI_CLOCK_EXECUTABLE ?? 'src-tauri/target/debug/ni-clock-in.exe'), [], {
      cwd: resolve('.'), windowsHide: true, stdio: 'ignore',
      env: { ...process.env, NI_CLOCK_DATA_DIR: join(directory, 'data'), NI_CLOCK_LEGACY_DIR: join(directory, 'no-legacy'), WEBVIEW2_USER_DATA_FOLDER: join(directory, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    });
    app.on('error', error => errors.push(error.message));
    await expect.poll(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } }, { timeout: 30_000 }).toBe(true);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    page = context.pages()[0] ?? await context.waitForEvent('page');
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '考勤总览', exact: true })).toBeVisible();
  });
  test.afterAll(async () => {
    await browser?.close();
    app?.kill();
  });
  test('创建部门和人员，保留设备 ID 前导零', async () => {
    await page.getByRole('button', { name: '人员与部门', exact: true }).click();
    await page.getByRole('button', { name: '添加部门', exact: true }).click();
    await page.getByRole('textbox', { name: '部门名称' }).fill('测试研发部');
    await page.getByRole('button', { name: '保存部门', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: '添加人员', exact: true }).first().click();
    await page.getByRole('textbox', { name: '姓名', exact: true }).fill('测试人员甲');
    await page.getByRole('textbox', { name: '设备 ID' }).fill('001');
    await page.getByRole('combobox', { name: '考勤班次', exact: true }).selectOption({ label: '标准工作日' });
    await page.getByRole('button', { name: '保存人员', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('测试人员甲', { exact: true })).toBeVisible();
    const data = await invoke<Bootstrap>('bootstrap');
    expect(data.config.people[0].deviceUserId).toBe('001');
    expect(data.config.departments).toHaveLength(2);
  });
  test('真实 CSV 导入、统计、人工修正与 Excel 导出', async () => {
    const csv = join(directory, 'punches.csv');
    await writeFile(csv, 'UserId,Timestamp,VerifyMode,InOutMode,WorkCode\n001,2026-04-06 09:31:00,1,0,0\n001,2026-04-06 12:00:00,1,1,0\n', 'utf8');
    await invoke('import_logs', { path: csv });
    await page.reload();
    await page.getByLabel('开始日期', { exact: true }).fill('2026-04-06');
    await page.getByLabel('结束日期', { exact: true }).fill('2026-04-06');
    await page.getByRole('button', { name: '计算统计', exact: true }).click();
    await expect(page.getByRole('table')).toBeVisible();
    await page.getByRole('button', { name: '查看测试人员甲明细', exact: true }).click();
    await page.getByRole('button', { name: '修正测试人员甲2026-04-06', exact: true }).click();
    await page.getByLabel('上午上班打卡', { exact: true }).fill('09:00:00');
    await page.getByRole('checkbox', { name: '免考勤', exact: true }).nth(1).check();
    await page.getByRole('textbox', { name: '修正备注', exact: true }).fill('下午请假（自动化测试）');
    await page.getByRole('button', { name: '保存并重新计算', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('cell', { name: '09:00:00', exact: true })).toBeVisible();
    const range = { startDate: '2026-04-06', endDate: '2026-04-06' };
    const statistics = await invoke<StatisticsResult>('calculate', { range, departmentIds: [] });
    expect(statistics.rows[0]).toMatchObject({ expectedDays: 0.5, actualDays: 0.5, lateCount: 0, absentDays: 0, attendanceHours: 3 });
    expect((await invoke<Bootstrap>('bootstrap')).reviewCount).toBe(1);
    const output = join(directory, 'week.xlsx');
    await invoke('export_statistics', { path: output, range, departmentIds: [] });
    expect((await readFile(output)).subarray(0, 2).toString()).toBe('PK');
    await page.screenshot({ path: join(directory, 'attendance.png'), fullPage: true });
    await page.reload();
    const persisted = await invoke<StatisticsResult>('calculate', { range, departmentIds: [] });
    expect(persisted.details[0].reviewed).toBe(true);
  });
  test('日志筛选、重复导入、错误反馈及 SDK 自检', async () => {
    await page.getByRole('button', { name: '原始记录', exact: true }).click();
    await expect(page.getByRole('cell', { name: '2026-04-06 09:31:00', exact: true })).toBeVisible();
    await page.getByLabel('搜索原始记录', { exact: true }).fill('不存在的用户');
    await expect(page.getByText('当前范围还没有打卡记录', { exact: true })).toBeVisible();
    const report = await invoke<{ added: number; skipped: number }>('import_logs', { path: join(directory, 'punches.csv') });
    expect(report).toMatchObject({ added: 0, skipped: 2 });
    await page.getByRole('button', { name: '设备连接', exact: true }).click();
    await expect(page.getByText('已就绪', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '开始下载', exact: true })).toBeDisabled();
    await page.screenshot({ path: join(directory, 'device.png'), fullPage: true });
    expect(errors).toEqual([]);
  });
});
