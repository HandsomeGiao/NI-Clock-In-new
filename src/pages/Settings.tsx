import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  Database,
  Download,
  FolderInput,
  HardDrive,
  History,
  Info,
  Plug,
  PlugZap,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  Upload,
  Wifi,
} from "lucide-react";
import { call, chooseDirectory, chooseFile, number, saveFile } from "../api";
import { Badge, Field, RangePicker } from "../components";
import { useApp } from "../context";
import type {
  ConnectionSettings,
  DeviceStatus,
  ImportSummary,
  Rules,
} from "../types";

export function DevicePage() {
  const {
    config,
    device,
    setDevice,
    range,
    setRange,
    run,
    saveConfig,
    refresh,
    progress,
    notify,
    navigate,
  } = useApp();
  const [connection, setConnection] = useState<ConnectionSettings>({
    ...config.connection,
  });
  useEffect(() => {
    setConnection({ ...config.connection });
  }, [config.connection]);
  async function connect() {
    await run(
      device.connected ? "正在断开设备…" : "正在连接考勤机…",
      async () => {
        if (device.connected) {
          setDevice(await call<DeviceStatus>("disconnect_device"));
          notify("设备连接已断开。");
          return;
        }
        await saveConfig({ ...config, connection });
        try {
          setDevice(
            await call<DeviceStatus>("connect_device", {
              settings: connection,
            }),
          );
          notify("考勤机连接成功。");
        } catch (error) {
          setDevice(await call<DeviceStatus>("device_status"));
          throw error;
        }
      },
    );
  }
  async function download() {
    await run("正在下载打卡记录…", async () => {
      await saveConfig({ ...config, query: range });
      const report = await call<ImportSummary>("download_logs", { range });
      await refresh();
      setDevice(await call<DeviceStatus>("device_status"));
      notify(
        `下载完成：新增 ${number(report.added)} 条，${number(report.skipped)} 条记录已存在。`,
      );
    });
  }
  return (
    <div className="device-layout">
      <section className="panel connection-panel">
        <div className="section-card-heading">
          <div className="section-card-icon">
            <Wifi size={23} />
          </div>
          <div>
            <h2>中控考勤机</h2>
            <p>ZKTeco · TCP/IP 局域网连接</p>
          </div>
          <Badge tone={device.connected ? "green" : "neutral"}>
            {device.connected ? "已连接" : "未连接"}
          </Badge>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <div className="form-grid">
            <Field label="设备 IP 地址" hint="在考勤机「通讯设置」中查看">
              <input
                required
                placeholder="例如：192.168.1.201"
                value={connection.ipAddress}
                onChange={(e) =>
                  setConnection({ ...connection, ipAddress: e.target.value })
                }
              />
            </Field>
            <Field label="通讯端口">
              <input
                required
                type="number"
                min={1}
                max={65535}
                value={connection.port}
                onChange={(e) =>
                  setConnection({ ...connection, port: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="通讯密码" hint="无通讯密码时填写 0">
              <input
                required
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={connection.commKey}
                onChange={(e) => {
                  if (/^\d*$/.test(e.target.value))
                    setConnection({
                      ...connection,
                      commKey: Number(e.target.value),
                    });
                }}
              />
            </Field>
            <Field label="机器号">
              <input
                required
                type="number"
                min={1}
                max={255}
                value={connection.machineNumber}
                onChange={(e) =>
                  setConnection({
                    ...connection,
                    machineNumber: Number(e.target.value),
                  })
                }
              />
            </Field>
          </div>
          <div className="connection-actions">
            <button
              type="button"
              className="button"
              onClick={() =>
                void run(
                  "正在保存连接参数…",
                  async () => {
                    await saveConfig({ ...config, connection });
                  },
                  "连接参数已保存",
                )
              }
            >
              <Save size={16} />
              保存参数
            </button>
            <button
              type="submit"
              className={`button ${device.connected ? "" : "primary"}`}
            >
              {device.connected ? <Plug size={16} /> : <PlugZap size={16} />}{" "}
              {device.connected ? "断开连接" : "连接设备"}
            </button>
          </div>
        </form>
        <div className="device-tip">
          <Info size={17} />
          <p>
            电脑与考勤机需要处于可互通的局域网。连接参数应与设备上的设置一致。
          </p>
        </div>
      </section>
      <section className="panel sdk-panel">
        <div className="compact-heading">
          <h3>设备与运行状态</h3>
          <button
            className="icon-button"
            aria-label="刷新设备状态"
            onClick={() =>
              void run("正在检查设备…", async () =>
                setDevice(await call<DeviceStatus>("device_status")),
              )
            }
          >
            <RefreshCw size={16} />
          </button>
        </div>
        <div className="sdk-illustration">
          <HardDrive size={56} strokeWidth={1.2} />
          <span className={device.connected ? "online-dot" : "offline-dot"} />
        </div>
        <div className="status-row">
          <span>设备连接</span>
          <Badge tone={device.connected ? "green" : "neutral"}>
            {device.connected ? "在线" : "未连接"}
          </Badge>
        </div>
        <div className="status-row">
          <span>设备记录数</span>
          <strong>
            {device.recordCount === null ? "—" : number(device.recordCount)}
          </strong>
        </div>
        <div className="status-row">
          <span>SDK 状态</span>
          <Badge tone={device.sdkAvailable ? "green" : "amber"}>
            {device.sdkAvailable ? "已就绪" : "待检查"}
          </Badge>
        </div>
        <p className="sdk-source">
          {device.sdkSource || "SDK 状态将在启动时检查"}
        </p>
        {device.error && (
          <div className="inline-error" role="alert">
            {device.error}
          </div>
        )}
      </section>
      <section className="panel download-panel">
        <div className="section-card-heading">
          <div className="section-card-icon">
            <Download size={23} />
          </div>
          <div>
            <h2>下载打卡记录</h2>
            <p>按日期保存到本地，重复记录自动去重</p>
          </div>
        </div>
        <div className="download-controls">
          <RangePicker range={range} onChange={setRange} />
          <button
            className="button primary"
            disabled={!device.connected}
            onClick={() => void download()}
          >
            <ArrowDownToLine size={16} />
            开始下载
          </button>
        </div>
        {!device.connected && (
          <p className="subtle">
            连接设备后即可下载。已有本地记录可随时查询和统计。
          </p>
        )}
        {progress && (
          <div className="download-progress">
            <div>
              <span>{progress.message}</span>
              <span>
                {number(progress.loaded)}
                {progress.total ? ` / ${number(progress.total)}` : ""}
              </span>
            </div>
            <progress
              max={Math.max(progress.total ?? progress.loaded, 1)}
              value={progress.loaded}
            />
          </div>
        )}
        <div className="download-bottom">
          <span>
            <ShieldCheck size={15} />
            原始记录完整保留在设备中
          </span>
          <button className="text-button" onClick={() => navigate("logs")}>
            查看本地记录 →
          </button>
        </div>
      </section>
    </div>
  );
}

export function SettingsPage() {
  const {
    config,
    boot,
    run,
    saveConfig,
    refresh,
    confirm,
    notify,
    range,
    setRange,
  } = useApp();
  const [rules, setRules] = useState<Rules>(structuredClone(config.rules));
  useEffect(() => {
    setRules(structuredClone(config.rules));
  }, [config.rules]);
  const dirty = JSON.stringify(rules) !== JSON.stringify(config.rules);
  async function exportBackup() {
    await run("正在创建完整备份…", async () => {
      const path = await saveFile(
        `NI考勤备份_${new Date().toISOString().slice(0, 10)}.json`,
        "json",
      );
      if (!path) return;
      await call("export_backup", { path });
      notify(`完整备份已保存：${path}`);
    });
  }
  async function restore() {
    try {
      const path = await chooseFile("恢复 NI 考勤备份", ["json"]);
      if (typeof path !== "string") return;
      confirm(
        "从完整备份恢复",
        `将使用 ${path} 中的配置、日志和修正记录替换当前数据。恢复前自动生成一份本地备份。`,
        async () => {
          await call("restore_backup", { path });
          await refresh(true);
          notify("备份已恢复。");
        },
      );
    } catch (error) {
      notify(String(error), true);
    }
  }
  async function migrate() {
    try {
      const directory = await chooseDirectory();
      if (typeof directory !== "string") return;
      confirm(
        "导入旧版 WinForms 数据",
        `将导入 ${directory} 中的人员、部门、班次和连接参数，并合并日志及人工修正。配置会被替换，导入前自动备份。`,
        async () => {
          const report = await call<ImportSummary>("import_legacy", {
            directory,
          });
          await refresh(true);
          notify(
            `导入完成：${report.updated} 位人员，新增 ${report.added} 条日志。`,
          );
        },
      );
    } catch (error) {
      notify(String(error), true);
    }
  }
  return (
    <div className="settings-layout">
      <section className="panel rules-panel">
        <div className="section-card-heading">
          <div className="section-card-icon">
            <Settings2 size={22} />
          </div>
          <div>
            <h2>考勤判定规则</h2>
            <p>与旧版四次打卡判定逻辑兼容</p>
          </div>
          {dirty && <Badge tone="amber">未保存</Badge>}
        </div>
        <div className="rules-content">
          <div className="setting-row">
            <div>
              <strong>迟到 / 早退容许时间</strong>
              <p>严格超过阈值才计为异常，精确到秒。</p>
            </div>
            <div className="number-input">
              <input
                aria-label="迟到早退阈值"
                type="number"
                min={0}
                max={240}
                value={rules.lateEarlyThresholdMinutes}
                onChange={(e) =>
                  setRules({
                    ...rules,
                    lateEarlyThresholdMinutes: Number(e.target.value),
                  })
                }
              />
              <span>分钟</span>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <strong>计算后优先查看明细</strong>
              <p>进入每日明细，便于逐条核对并保存修正。</p>
            </div>
            <label className="switch">
              <input
                aria-label="计算后优先查看明细"
                type="checkbox"
                checked={rules.debugDetailsEnabled}
                onChange={(e) =>
                  setRules({ ...rules, debugDetailsEnabled: e.target.checked })
                }
              />
              <span />
            </label>
          </div>
          <div className="window-heading">
            <h3>有效打卡窗口</h3>
            <p>上班取最早，下班取最晚。窗口互不重叠，包含起止时刻。</p>
          </div>
          <div className="window-list">
            {rules.windows.map((window, i) => (
              <div className="window-row" key={i}>
                <div>
                  <span className="window-number">0{i + 1}</span>
                  <strong>
                    {["上午上班", "上午下班", "下午上班", "下午下班"][i]}
                  </strong>
                  <Badge>{i % 2 === 0 ? "取最早" : "取最晚"}</Badge>
                </div>
                <div className="time-pair">
                  <input
                    type="time"
                    aria-label={`窗口${i + 1}开始`}
                    value={window.start}
                    onChange={(e) =>
                      setRules({
                        ...rules,
                        windows: rules.windows.map((w, j) =>
                          i === j ? { ...w, start: e.target.value } : w,
                        ),
                      })
                    }
                  />
                  <span>至</span>
                  <input
                    type="time"
                    aria-label={`窗口${i + 1}结束`}
                    value={window.end}
                    onChange={(e) =>
                      setRules({
                        ...rules,
                        windows: rules.windows.map((w, j) =>
                          i === j ? { ...w, end: e.target.value } : w,
                        ),
                      })
                    }
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="rule-explanation">
            <Info size={17} />
            <div>
              <strong>如何计算出勤</strong>
              <p>
                每个启用时段算半天。两次均缺卡则缺勤半天；只缺一侧时，使用该侧计划时间计算工时。免考勤时段不计应到、实到和工时。
              </p>
            </div>
          </div>
          <div className="connection-actions">
            <button
              className="button"
              onClick={() =>
                setRules({
                  lateEarlyThresholdMinutes: 30,
                  debugDetailsEnabled: false,
                  windows: [
                    { start: "07:00", end: "10:30" },
                    { start: "11:30", end: "13:00" },
                    { start: "13:01", end: "15:30" },
                    { start: "17:00", end: "18:30" },
                  ],
                })
              }
            >
              恢复默认值
            </button>
            <button
              className="button primary"
              disabled={!dirty}
              onClick={() =>
                void run(
                  "正在保存考勤规则…",
                  async () => {
                    await saveConfig({ ...config, rules });
                  },
                  "考勤规则已保存，请重新计算统计",
                )
              }
            >
              <Save size={16} />
              保存规则
            </button>
          </div>
        </div>
      </section>
      <section className="panel data-panel">
        <div className="section-card-heading">
          <div className="section-card-icon">
            <Database size={22} />
          </div>
          <div>
            <h2>数据与备份</h2>
            <p>所有数据仅保存在本机</p>
          </div>
        </div>
        <div className="data-counts">
          <div>
            <strong>{number(boot.logCount)}</strong>
            <span>原始记录</span>
          </div>
          <div>
            <strong>{number(boot.reviewCount)}</strong>
            <span>人工修正</span>
          </div>
          <div>
            <strong>{config.people.length}</strong>
            <span>人员档案</span>
          </div>
        </div>
        <div className="data-actions">
          <button onClick={() => void exportBackup()}>
            <span className="data-action-icon">
              <Download size={20} />
            </span>
            <div>
              <strong>导出完整备份</strong>
              <small>配置、人员、打卡记录与人工修正</small>
            </div>
            <ArrowDownToLine size={17} />
          </button>
          <button onClick={() => void restore()}>
            <span className="data-action-icon">
              <Upload size={20} />
            </span>
            <div>
              <strong>从备份恢复</strong>
              <small>恢复 NI 考勤 JSON 备份文件</small>
            </div>
            <Upload size={17} />
          </button>
          <button onClick={() => void migrate()}>
            <span className="data-action-icon">
              <FolderInput size={20} />
            </span>
            <div>
              <strong>导入旧版数据</strong>
              <small>选择旧版项目或 data 文件夹</small>
            </div>
            <FolderInput size={17} />
          </button>
        </div>
        <div className="storage-path">
          <span>
            <HardDrive size={14} />
            当前数据目录
          </span>
          <code>{boot.dataDirectory}</code>
          <small>SQLite 数据库及导入前自动备份保存在此目录。</small>
        </div>
      </section>
      <section className="panel reset-panel">
        <div className="section-card-heading">
          <div className="section-card-icon">
            <History size={22} />
          </div>
          <div>
            <h2>恢复原始考勤判定</h2>
            <p>按日期范围撤销人工修正，重新使用原始打卡计算</p>
          </div>
        </div>
        <div className="reset-controls">
          <RangePicker range={range} onChange={setRange} />
          <button
            className="button danger"
            onClick={() =>
              confirm(
                "撤销指定范围的人工修正",
                `将清除 ${range.startDate} 至 ${range.endDate} 所有人员的人工补卡、免考勤和备注。原始打卡记录会保留。`,
                async () => {
                  const count = await call<number>("reset_reviews", { range });
                  await refresh();
                  notify(`已撤销 ${count} 条人工修正。`);
                },
              )
            }
          >
            <History size={16} />
            撤销范围内修正
          </button>
        </div>
      </section>
    </div>
  );
}
