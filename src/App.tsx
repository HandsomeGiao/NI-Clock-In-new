import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpRight,
  CalendarDays,
  ChartNoAxesCombined,
  Check,
  ChevronRight,
  CircleHelp,
  Database,
  FileClock,
  HardDrive,
  LoaderCircle,
  Settings2,
  ShieldCheck,
  Users,
  Wifi,
  X,
} from "lucide-react";
import { call, chooseDirectory } from "./api";
import { AppContext } from "./context";
import { Modal } from "./components";
import { StatisticsPage, LogsPage } from "./pages/Attendance";
import { PeoplePage, ShiftsPage } from "./pages/Organization";
import { DevicePage, SettingsPage } from "./pages/Settings";
import type {
  AppConfig,
  Bootstrap,
  DateRange,
  DeviceStatus,
  ImportSummary,
  Page,
  Progress,
} from "./types";

const navigation = [
  {
    id: "statistics" as const,
    label: "考勤总览",
    icon: ChartNoAxesCombined,
    description: "每一份出勤，都有迹可循。",
  },
  {
    id: "logs" as const,
    label: "原始记录",
    icon: FileClock,
    description: "来自考勤机的每一次打卡，完整保存在本地。",
  },
  {
    id: "people" as const,
    label: "人员与部门",
    icon: Users,
    description: "管理团队成员，让每条记录找到对应的人。",
  },
  {
    id: "shifts" as const,
    label: "班次设置",
    icon: CalendarDays,
    description: "按周安排工作时间，适配不同的出勤节奏。",
  },
  {
    id: "device" as const,
    label: "设备连接",
    icon: Wifi,
    description: "连接中控考勤机，同步真实的打卡记录。",
  },
  {
    id: "settings" as const,
    label: "规则与数据",
    icon: Settings2,
    description: "设置考勤规则，妥善保存每一份数据。",
  },
];
const offline: DeviceStatus = {
  connected: false,
  sdkAvailable: false,
  recordCount: null,
  sdkSource: "",
  error: null,
};
export default function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null),
    [startupError, setStartupError] = useState("");
  const [page, setPage] = useState<Page>("statistics");
  const [range, setRange] = useState<DateRange>({ startDate: "", endDate: "" });
  const [device, setDevice] = useState<DeviceStatus>(offline),
    [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState<string | null>(null),
    busyRef = useRef(false),
    [dataVersion, setDataVersion] = useState(0);
  const [toast, setToast] = useState<{
    message: string;
    error: boolean;
    at: number;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    description: string;
    action: () => Promise<void>;
  } | null>(null);
  const [help, setHelp] = useState(false),
    [hideMigration, setHideMigration] = useState(false);
  const notify = useCallback(
    (message: string, error = false) =>
      setToast({ message, error, at: Date.now() }),
    [],
  );
  const refresh = useCallback(async (useSavedRange = false) => {
    const next = await call<Bootstrap>("bootstrap");
    setBoot(next);
    setDataVersion((v) => v + 1);
    if (useSavedRange) setRange(next.config.query);
  }, []);
  useEffect(() => {
    let active = true;
    call<Bootstrap>("bootstrap")
      .then((next) => {
        if (active) {
          setBoot(next);
          setRange(next.config.query);
        }
      })
      .catch((e) => {
        if (active) setStartupError(String(e));
      });
    call<DeviceStatus>("device_status")
      .then((status) => {
        if (active) setDevice(status);
      })
      .catch((e) => {
        if (active) setDevice({ ...offline, error: String(e) });
      });
    const unsubscribe = listen<Progress>("download-progress", (e) => {
      if (active) setProgress(e.payload);
    }).catch(() => () => {});
    return () => {
      active = false;
      void unsubscribe.then((fn) => fn());
    };
  }, []);
  useEffect(() => {
    if (!toast || toast.error) return;
    const timer = setTimeout(() => setToast(null), 6500);
    return () => clearTimeout(timer);
  }, [toast]);
  async function run<T>(
    label: string,
    action: () => Promise<T>,
    success?: string,
  ): Promise<T | undefined> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label);
    try {
      const result = await action();
      if (success) notify(success);
      return result;
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
      return undefined;
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }
  async function saveConfig(config: AppConfig) {
    const saved = await call<AppConfig>("save_config", { config });
    setBoot((previous) =>
      previous ? { ...previous, config: saved } : previous,
    );
    setDataVersion((v) => v + 1);
    return saved;
  }
  function confirm(
    title: string,
    description: string,
    action: () => Promise<void>,
  ) {
    setConfirmation({ title, description, action });
  }
  async function migrate() {
    const directory = boot?.legacyPath ?? (await chooseDirectory());
    if (typeof directory !== "string") return;
    confirm(
      "导入旧版数据",
      `将从 ${directory} 导入人员、部门、班次和连接设置，并合并已有日志及人工修正。当前配置将被替换，程序会先自动备份。`,
      async () => {
        const report = await call<ImportSummary>("import_legacy", {
          directory,
        });
        await refresh(true);
        setHideMigration(true);
        notify(
          `旧版数据导入完成：${report.updated} 位人员，新增 ${report.added} 条日志。`,
        );
      },
    );
  }
  const current = navigation.find((item) => item.id === page)!;
  if (!boot)
    return (
      <div className="startup-error">
        <img src="/icon.svg" alt="NI" />
        <h1>NI 考勤工作台</h1>
        {startupError ? (
          <>
            <p role="alert">{startupError}</p>
            <button
              className="button primary"
              onClick={() => location.reload()}
            >
              重新加载
            </button>
          </>
        ) : (
          <>
            <LoaderCircle className="spin" />
            <p>正在打开本地工作台…</p>
          </>
        )}
      </div>
    );
  const context = {
    boot,
    config: boot.config,
    busy,
    dataVersion,
    range,
    setRange,
    device,
    setDevice,
    progress,
    navigate: setPage,
    refresh,
    saveConfig,
    run,
    notify,
    confirm,
  };
  return (
    <AppContext.Provider value={context}>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <img src="/icon.svg" alt="" />
            <div>
              <strong>NI 考勤</strong>
              <span>ATTENDANCE STUDIO</span>
            </div>
          </div>
          <div className="workspace-label">
            <span className="workspace-dot" />
            本地工作空间<span className="version">2.0</span>
          </div>
          <div className="nav-caption">工作台</div>
          <nav aria-label="主导航">
            {navigation.map(({ id, label, icon: Icon }, i) => (
              <button
                key={id}
                className={`nav-item ${page === id ? "active" : ""} ${i === 4 ? "separated" : ""}`}
                onClick={() => setPage(id)}
                disabled={!!busy}
              >
                <Icon size={19} />
                <span>{label}</span>
                {page === id && <span className="nav-active-dot" />}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <button
              className="device-mini"
              onClick={() => setPage("device")}
              disabled={!!busy}
            >
              <div className="device-mini-icon">
                <HardDrive size={20} />
              </div>
              <div>
                <strong>
                  {device.connected ? "考勤机已连接" : "考勤机未连接"}
                </strong>
                <span>
                  <i
                    className={device.connected ? "online-dot" : "offline-dot"}
                  />
                  {device.connected
                    ? boot.config.connection.ipAddress
                    : "连接设备以同步记录"}
                </span>
              </div>
              <ChevronRight size={15} />
            </button>
            <div className="local-note">
              <ShieldCheck size={15} />
              <span>数据保存在此电脑</span>
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="breadcrumbs">
              工作台
              <ChevronRight size={13} />
              <span>{current.label}</span>
            </div>
            <div className="topbar-right">
              <span className="local-status">
                <span />
                本地数据服务
              </span>
              <button
                className="icon-button"
                aria-label="使用帮助"
                onClick={() => setHelp(true)}
              >
                <CircleHelp size={19} />
              </button>
              <div className="profile-avatar">NI</div>
            </div>
          </header>
          <main>
            <div className="page-heading">
              <div>
                <div className="eyebrow">NI / WORKSPACE</div>
                <h1>{current.label}</h1>
                <p>{current.description}</p>
              </div>
              <div className="heading-date">
                <CalendarDays size={16} />
                {new Date().toLocaleDateString("zh-CN", {
                  month: "long",
                  day: "numeric",
                  weekday: "long",
                })}
              </div>
            </div>
            {!hideMigration &&
              boot.legacyPath &&
              boot.config.people.length === 0 && (
                <div className="migration-banner">
                  <div className="banner-icon">
                    <Database size={22} />
                  </div>
                  <div>
                    <strong>继续使用你的考勤数据</strong>
                    <p>已发现旧版项目，可导入人员、班次和设备设置。</p>
                  </div>
                  <button
                    className="button"
                    disabled={!!busy}
                    onClick={() => void migrate()}
                  >
                    导入旧版数据
                    <ArrowUpRight size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="暂时关闭迁移提示"
                    onClick={() => setHideMigration(true)}
                  >
                    <X size={16} />
                  </button>
                </div>
              )}
            <fieldset className="page-content" disabled={!!busy}>
              {page === "statistics" && <StatisticsPage />}
              {page === "logs" && <LogsPage />}
              {page === "people" && <PeoplePage />}
              {page === "shifts" && <ShiftsPage />}
              {page === "device" && <DevicePage />}
              {page === "settings" && <SettingsPage />}
            </fieldset>
            <footer className="page-footer">
              <span>
                <ShieldCheck size={13} />
                本地存储 · 随时备份
              </span>
              <span>NI Clock In / 2.0.0</span>
            </footer>
          </main>
        </div>
      </div>
      {busy && (
        <div className="busy-indicator" role="status">
          <LoaderCircle size={18} className="spin" />
          {busy}
          {progress && busy.includes("下载") && <span>{progress.message}</span>}
        </div>
      )}
      {toast && (
        <div
          role={toast.error ? "alert" : "status"}
          className={`toast ${toast.error ? "error" : ""}`}
        >
          {toast.error ? <Activity size={19} /> : <Check size={19} />}
          <span>{toast.message}</span>
          <button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => setToast(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {confirmation && (
        <Modal
          title={confirmation.title}
          onClose={() => !busy && setConfirmation(null)}
        >
          <p className="confirm-copy">{confirmation.description}</p>
          <div className="modal-actions">
            <button
              className="button"
              disabled={!!busy}
              onClick={() => setConfirmation(null)}
            >
              取消
            </button>
            <button
              className="button primary"
              disabled={!!busy}
              onClick={() =>
                void run(confirmation.title, async () => {
                  await confirmation.action();
                  setConfirmation(null);
                })
              }
            >
              确认继续
            </button>
          </div>
        </Modal>
      )}
      {help && (
        <Modal
          title="开始使用 NI 考勤"
          subtitle="一个完整的考勤工作流程"
          onClose={() => setHelp(false)}
        >
          <ol className="help-steps">
            <li>
              <strong>准备人员和班次</strong>
              <p>导入旧版数据，或在「人员与部门」添加人员并分配周班次。</p>
            </li>
            <li>
              <strong>同步打卡记录</strong>
              <p>
                在「设备连接」填写考勤机参数，连接后按日期下载；也可在「原始记录」导入
                CSV。
              </p>
            </li>
            <li>
              <strong>计算与核对</strong>
              <p>
                选择日期和部门计算考勤，在每日明细中补卡、免考勤并填写备注。
              </p>
            </li>
            <li>
              <strong>导出与备份</strong>
              <p>
                导出 Excel
                周报，选择多份周报汇总月报；在「规则与数据」创建完整备份。
              </p>
            </li>
          </ol>
          <div className="info-note">
            <ArrowDownToLine size={17} />
            下载只读取设备记录，不清空考勤机数据。
          </div>
          <div className="modal-actions">
            <button className="button primary" onClick={() => setHelp(false)}>
              开始使用
            </button>
          </div>
        </Modal>
      )}
    </AppContext.Provider>
  );
}
