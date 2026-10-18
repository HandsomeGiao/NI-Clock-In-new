import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { Bootstrap, StatisticsResult } from '../src/types';

type StartupTestWindow = Window & {
  __startupTest: { release: () => void; bootstrapCalls: number; appMounted: boolean };
};

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
      env: { ...process.env, NI_CLOCK_DATA_DIR: join(directory, 'data'), NI_CLOCK_LEGACY_DIR: join(directory, 'no-legacy'), WEBVIEW2_USER_DATA_FOLDER: undefined, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    });
    app.on('error', error => errors.push(error.message));
    await expect.poll(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } }, { timeout: 30_000 }).toBe(true);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    page = context.pages()[0] ?? await context.waitForEvent('page');
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '考勤总览', exact: true })).toBeVisible();
    await expect.poll(() => invoke<boolean>('plugin:window|is_visible', { label: 'main' })).toBe(true);
    expect(await invoke<string>('data_directory')).toBe(join(directory, 'data'));
    expect((await stat(join(directory, 'data', 'webview'))).isDirectory()).toBe(true);
  });
  test.afterAll(async () => {
    await browser?.close();
    app?.kill();
  });
  async function holdEntryScript() {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pattern = /\/assets\/index-[^/]+\.js$/;
    await page.route(pattern, async route => {
      await gate;
      await route.continue();
    });
    await page.reload({ waitUntil: 'commit' });
    return {
      release,
      async cleanup() {
        release();
        await page.unroute(pattern);
      },
    };
  }
  test('脚本尚未加载时已有启动画面，准备完成后立即进入工作台', async () => {
    const held = await holdEntryScript();
    try {
      await expect(page.getByRole('heading', { name: 'NI 考勤工作台', exact: true })).toBeVisible();
      await expect(page.getByRole('status')).toHaveText('正在打开本地工作台…');
      await expect(page.getByRole('navigation', { name: '主导航' })).toHaveCount(0);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      expect(await page.locator('.startup-orbit').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      held.release();
      await expect(page.getByRole('heading', { name: '考勤总览', exact: true })).toBeVisible();
      await expect(page.locator('#startup-screen')).toHaveCount(0);
    } finally {
      await held.cleanup();
    }
  });
  test('数据读取较慢时保持启动画面，初始化只读取一次数据', async () => {
    const held = await holdEntryScript();
    try {
      await page.evaluate(() => {
        const target = window as unknown as StartupTestWindow;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        target.__startupTest = { release, bootstrapCalls: 0, appMounted: false };
        const original = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const command = new URL(input instanceof Request ? input.url : String(input)).pathname;
          if (command === '/device_status') target.__startupTest.appMounted = true;
          if (command === '/bootstrap') {
            target.__startupTest.bootstrapCalls++;
            const result = await original(input, init);
            await gate;
            return result;
          }
          return original(input, init);
        };
      });
      held.release();
      await expect.poll(() => page.evaluate(() => (window as unknown as StartupTestWindow).__startupTest.appMounted)).toBe(true);
      await expect(page.getByRole('status')).toHaveText('正在读取本地数据…');
      await expect(page.getByRole('heading', { name: '考勤总览', exact: true })).toHaveCount(0);
      await page.screenshot({ path: join(directory, 'startup.png'), fullPage: true, timeout: 5000 });
      expect(await page.evaluate(() => (window as unknown as StartupTestWindow).__startupTest.bootstrapCalls)).toBe(1);
      await page.evaluate(() => (window as unknown as StartupTestWindow).__startupTest.release());
      await expect(page.getByRole('heading', { name: '考勤总览', exact: true })).toBeVisible();
      await expect(page.locator('#startup-screen')).toHaveCount(0);
    } finally {
      await held.cleanup();
    }
  });
  test('初始化失败提供错误和重试入口，重试后可正常进入', async () => {
    const held = await holdEntryScript();
    try {
      await page.evaluate(() => {
        const original = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const command = new URL(input instanceof Request ? input.url : String(input)).pathname;
          if (command === '/bootstrap') return new Response('测试：本地数据暂时无法读取', {
            headers: { 'Content-Type': 'text/plain', 'Tauri-Response': 'error' },
          });
          return original(input, init);
        };
      });
      held.release();
      await expect(page.getByRole('alert')).toHaveText('测试：本地数据暂时无法读取');
      await expect(page.getByRole('link', { name: '重新加载', exact: true })).toBeVisible();
    } finally {
      await held.cleanup();
    }
    await page.getByRole('link', { name: '重新加载', exact: true }).click();
    await expect(page.getByRole('heading', { name: '考勤总览', exact: true })).toBeVisible();
    await expect(page.locator('#startup-screen')).toHaveCount(0);
  });
  test('主界面资源加载失败时保留可恢复的启动画面', async () => {
    const pattern = /\/assets\/main-[^/]+\.js$/;
    await page.route(pattern, route => route.abort('failed'));
    try {
      await page.reload();
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(page.getByRole('link', { name: '重新加载', exact: true })).toBeVisible();
    } finally {
      await page.unroute(pattern);
    }
    await page.getByRole('link', { name: '重新加载', exact: true }).click();
    await expect(page.getByRole('heading', { name: '考勤总览', exact: true })).toBeVisible();
    await expect(page.locator('#startup-screen')).toHaveCount(0);
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
    const exportDirectory = join(directory, '自选导出目录');
    await mkdir(exportDirectory);
    const output = join(exportDirectory, '统计报表.xlsx');
    await invoke('export_statistics', { path: output, range, departmentIds: [] });
    expect((await readFile(output)).subarray(0, 2).toString()).toBe('PK');
    const csvOutput = join(exportDirectory, '打卡记录.csv');
    expect(await invoke<number>('export_logs', { path: csvOutput, query: { range, search: '', departmentIds: [], page: 0, pageSize: 50 } })).toBe(2);
    expect(await readFile(csvOutput, 'utf8')).toContain('001');
    const backupOutput = join(exportDirectory, '完整备份.json');
    await invoke('export_backup', { path: backupOutput });
    const backup = JSON.parse(await readFile(backupOutput, 'utf8'));
    expect(backup.config.people[0].deviceUserId).toBe('001');
    expect(backup.logs).toHaveLength(2);
    const monthlyOutput = join(exportDirectory, '月报.xlsx');
    expect(await invoke<number>('merge_monthly', { paths: [output], path: monthlyOutput })).toBe(1);
    expect((await readFile(monthlyOutput)).subarray(0, 2).toString()).toBe('PK');
    await expect(invoke('merge_monthly', { paths: [output], path: output })).rejects.toThrow('月报输出文件不能覆盖输入周报');
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
  test('默认出勤支持日期和人员选择、编辑、持久化及撤销，保留原始记录和人工修正', async () => {
    const before = await invoke<Bootstrap>('bootstrap');
    const range = { startDate: '2026-04-07', endDate: '2026-04-09' };
    const baseline = await invoke<StatisticsResult>('calculate', { range, departmentIds: [] });
    await page.getByRole('button', { name: '考勤总览', exact: true }).click();
    await page.getByLabel('开始日期', { exact: true }).fill(range.startDate);
    await page.getByLabel('结束日期', { exact: true }).fill(range.endDate);
    await page.getByRole('button', { name: /^默认出勤/ }).click();
    const editor = page.getByRole('dialog', { name: '默认出勤设置', exact: true });
    await editor.getByRole('button', { name: '保存默认出勤', exact: true }).click();
    await expect(editor.getByRole('alert')).toHaveText('请至少选择一位人员和一个时段。');
    await editor.getByLabel('筛选默认出勤部门', { exact: true }).selectOption({ label: '测试研发部' });
    await editor.getByRole('button', { name: '全选筛选结果', exact: true }).click();
    await expect(editor.getByRole('checkbox', { name: '选择测试人员甲（001）', exact: true })).toBeChecked();
    await editor.getByLabel('默认出勤结束日期', { exact: true }).fill('2026-04-08');
    await editor.getByRole('checkbox', { name: '周二上午', exact: true }).check();
    await editor.getByRole('checkbox', { name: '周三上午', exact: true }).check();
    await editor.getByRole('textbox', { name: '默认出勤原因（选填）', exact: true }).fill('设备故障，上午按正常出勤');
    await editor.getByRole('button', { name: '保存默认出勤', exact: true }).click();
    await expect(editor.getByText('已保存设置 · 1 条', { exact: true })).toBeVisible();
    let result = await invoke<StatisticsResult>('calculate', { range, departmentIds: [] });
    expect(result.rows[0]).toMatchObject({ expectedDays: 3, actualDays: 1, absentDays: 2, attendanceHours: 6, lateCount: 0, earlyLeaveCount: 0 });
    expect(result.details.map(detail => detail.defaultAttendance)).toEqual([[true, false], [true, false], [false, false]]);
    expect(result.details.every(detail => detail.punches.every(punch => punch === null))).toBe(true);
    await editor.getByRole('button', { name: '完成', exact: true }).click();
    await expect(page.getByRole('table')).toBeVisible();
    await page.getByRole('button', { name: /^每日明细/ }).click();
    const firstDay = page.getByRole('row').filter({ hasText: '2026-04-07' });
    await expect(firstDay.getByText('默认出勤', { exact: true })).toHaveCount(3);
    await page.screenshot({ path: join(directory, 'default-attendance-details.png'), fullPage: true });
    await page.reload();
    await page.getByRole('button', { name: /^默认出勤/ }).click();
    await expect(editor.getByText('设备故障，上午按正常出勤', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: /^编辑默认出勤/ }).click();
    await editor.getByLabel('默认出勤结束日期', { exact: true }).fill(range.endDate);
    await editor.getByRole('button', { name: '清空时段', exact: true }).click();
    await editor.getByRole('checkbox', { name: '周二下午', exact: true }).check();
    await editor.getByRole('checkbox', { name: '周三下午', exact: true }).check();
    await editor.getByRole('checkbox', { name: '周四下午', exact: true }).check();
    await editor.getByRole('textbox', { name: '默认出勤原因（选填）', exact: true }).fill('下午外出培训');
    await editor.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(editor.getByText('下午外出培训', { exact: true })).toBeVisible();
    result = await invoke<StatisticsResult>('calculate', { range, departmentIds: [] });
    expect(result.rows[0]).toMatchObject({ expectedDays: 3, actualDays: 1.5, absentDays: 1.5, attendanceHours: 10.5 });
    const backupPath = join(directory, '默认出勤备份.json');
    await invoke('export_backup', { path: backupPath });
    const backup = JSON.parse(await readFile(backupPath, 'utf8'));
    expect(backup.config.defaultAttendancePeriods[0]).toMatchObject({ range, weeklyPeriods: [[false, false], [false, false], [false, true], [false, true], [false, true], [false, false], [false, false]], note: '下午外出培训' });
    await page.screenshot({ path: join(directory, 'default-attendance-settings.png'), fullPage: true });
    await editor.getByRole('button', { name: /^删除默认出勤/ }).click();
    const confirmation = page.getByRole('dialog', { name: '删除默认出勤设置', exact: true });
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    expect((await invoke<Bootstrap>('bootstrap')).config.defaultAttendancePeriods).toHaveLength(1);
    await editor.getByRole('button', { name: /^删除默认出勤/ }).click();
    await confirmation.getByRole('button', { name: '确认继续', exact: true }).click();
    await expect(editor.getByText('尚未设置默认出勤。', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: '完成', exact: true }).click();
    const after = await invoke<Bootstrap>('bootstrap');
    expect(after.logCount).toBe(before.logCount);
    expect(after.reviewCount).toBe(before.reviewCount);
    expect(after.config.people).toEqual(before.config.people);
    result = await invoke<StatisticsResult>('calculate', { range, departmentIds: [] });
    expect(result).toEqual(baseline);
    expect(errors).toEqual([]);
  });
  test('批量删除支持多选、取消确认和持久化，保留已分配班次', async () => {
    const before = await invoke<Bootstrap>('bootstrap');
    const extraShifts = ['待删除早班', '待删除晚班', '保留班次'].map((name, index) => ({
      ...structuredClone(before.config.shifts[0]), id: `bulk-shift-${index}`, name,
    }));
    await invoke('save_config', { config: { ...before.config, shifts: [...before.config.shifts, ...extraShifts] } });
    await page.reload();
    await page.getByRole('button', { name: '班次设置', exact: true }).click();
    await page.getByRole('button', { name: /^待删除早班/ }).click();
    await page.getByRole('textbox', { name: '班次名称', exact: true }).fill('待删除早班（未保存）');
    await page.getByRole('button', { name: '批量删除班次', exact: true }).click();
    const selection = page.getByRole('dialog', { name: '批量删除班次', exact: true });
    await expect(selection.getByRole('button', { name: '删除所选班次（0）', exact: true })).toBeDisabled();
    await expect(selection.getByRole('checkbox', { name: '选择班次「标准工作日」', exact: true })).toBeDisabled();
    await selection.getByRole('checkbox', { name: '选择班次「待删除早班」', exact: true }).check();
    await expect(selection.getByRole('checkbox', { name: '全选可删除班次', exact: true })).toHaveJSProperty('indeterminate', true);
    await selection.getByRole('checkbox', { name: '全选可删除班次', exact: true }).check();
    await selection.getByRole('checkbox', { name: '选择班次「保留班次」', exact: true }).uncheck();
    await expect(selection.getByText('已选 2 / 3', { exact: true })).toBeVisible();
    await page.screenshot({ path: join(directory, 'bulk-delete-shifts.png'), fullPage: true });
    await selection.getByRole('button', { name: '删除所选班次（2）', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '删除所选的 2 个班次', exact: true });
    await expect(confirmation).toContainText('当前班次尚未保存的修改也会丢弃');
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    expect((await invoke<Bootstrap>('bootstrap')).config.shifts).toHaveLength(4);
    await selection.getByRole('button', { name: '删除所选班次（2）', exact: true }).click();
    await confirmation.getByRole('button', { name: '确认继续', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '班次名称', exact: true })).toHaveValue('标准工作日');
    await page.reload();
    await page.getByRole('button', { name: '班次设置', exact: true }).click();
    await expect(page.getByRole('button', { name: /^待删除/ })).toHaveCount(0);
    const after = await invoke<Bootstrap>('bootstrap');
    expect(after.config.shifts.map(shift => shift.name)).toEqual(['标准工作日', '保留班次']);
    expect(after.config.people).toEqual(before.config.people);
    expect(after.logCount).toBe(before.logCount);
    expect(after.reviewCount).toBe(before.reviewCount);
  });
  test('删除其他班次保留当前草稿，并处理全为已分配及删除全部班次', async () => {
    const before = await invoke<Bootstrap>('bootstrap');
    const extra = { ...structuredClone(before.config.shifts[0]), id: 'bulk-extra', name: '其他待删除班次' };
    await invoke('save_config', { config: { ...before.config, shifts: [...before.config.shifts, extra] } });
    await page.reload();
    await page.getByRole('button', { name: '班次设置', exact: true }).click();
    await page.getByRole('textbox', { name: '班次名称', exact: true }).fill('标准工作日（未保存）');
    await page.getByRole('button', { name: '批量删除班次', exact: true }).click();
    const selection = page.getByRole('dialog', { name: '批量删除班次', exact: true });
    await selection.getByRole('checkbox', { name: '全选可删除班次', exact: true }).check();
    await selection.getByRole('button', { name: '删除所选班次（2）', exact: true }).click();
    await page.getByRole('dialog', { name: '删除所选的 2 个班次', exact: true }).getByRole('button', { name: '确认继续', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '班次名称', exact: true })).toHaveValue('标准工作日（未保存）');
    await expect(page.getByRole('button', { name: '保存班次', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '批量删除班次', exact: true }).click();
    await expect(selection.getByText('所有班次均已分配人员，暂无可删除的班次。', { exact: true })).toBeVisible();
    await expect(selection.getByRole('checkbox', { name: '全选可删除班次', exact: true })).toBeDisabled();
    await expect(selection.getByRole('button', { name: '删除所选班次（0）', exact: true })).toBeDisabled();
    await selection.getByRole('button', { name: '取消', exact: true }).click();
    const assigned = await invoke<Bootstrap>('bootstrap');
    await invoke('save_config', { config: { ...assigned.config, people: assigned.config.people.map(person => ({ ...person, shiftId: null })) } });
    await page.reload();
    await page.getByRole('button', { name: '班次设置', exact: true }).click();
    await page.getByRole('button', { name: '批量删除班次', exact: true }).click();
    await selection.getByRole('checkbox', { name: '全选可删除班次', exact: true }).check();
    await selection.getByRole('button', { name: '删除所选班次（1）', exact: true }).click();
    await page.getByRole('dialog', { name: '删除所选的 1 个班次', exact: true }).getByRole('button', { name: '确认继续', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('创建一份周班次', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '批量删除班次', exact: true })).toBeDisabled();
    expect((await invoke<Bootstrap>('bootstrap')).config.shifts).toEqual([]);
    expect(errors).toEqual([]);
  });
});
