import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Calculator,
  CalendarCheck2,
  Check,
  ChevronDown,
  Clock3,
  Download,
  FileSpreadsheet,
  Filter,
  History,
  Info,
  PencilLine,
  Search,
  Upload,
  UserCheck,
  Users,
  X,
} from "lucide-react";
import { call, chooseFile, number, saveFile, weekName } from "../api";
import {
  Badge,
  Empty,
  Field,
  Loading,
  Modal,
  Pagination,
  RangePicker,
} from "../components";
import { useApp } from "../context";
import type {
  Detail,
  ImportSummary,
  LogPage,
  LogQuery,
  Review,
  StatisticsResult,
} from "../types";

function DepartmentFilter({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { config } = useApp();
  return (
    <details className="department-filter">
      <summary>
        <Filter size={15} />
        {selected.length ? `${selected.length} 个部门` : "全部部门"}
        <ChevronDown size={14} />
      </summary>
      <div className="department-menu">
        <button className="text-button" onClick={() => onChange([])}>
          全部部门
        </button>
        {config.departments.map((d) => (
          <label key={d.id}>
            <input
              type="checkbox"
              checked={selected.includes(d.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...selected, d.id]
                    : selected.filter((id) => id !== d.id),
                )
              }
            />
            {d.name}
          </label>
        ))}
        <small>未勾选时包含所有部门</small>
      </div>
    </details>
  );
}
export function StatisticsPage() {
  const {
    config,
    range,
    setRange,
    run,
    saveConfig,
    dataVersion,
    notify,
    navigate,
    refresh,
  } = useApp();
  const [departments, setDepartments] = useState<string[]>([]),
    [result, setResult] = useState<StatisticsResult | null>(null);
  const [tab, setTab] = useState<"summary" | "details">("summary"),
    [search, setSearch] = useState(""),
    [personId, setPersonId] = useState("");
  const [page, setPage] = useState(0),
    [edit, setEdit] = useState<Detail | null>(null),
    [onlyAbnormal, setOnlyAbnormal] = useState(false);
  const [sort, setSort] = useState("department");
  const size = 20;
  useEffect(() => {
    setResult(null);
    setPage(0);
  }, [range.startDate, range.endDate, departments, dataVersion]);
  useEffect(() => {
    setPage(0);
  }, [search, tab, personId, onlyAbnormal]);
  async function calculate() {
    await run("正在计算考勤…", async () => {
      if (!range.startDate || !range.endDate)
        throw new Error("请选择完整日期范围");
      await saveConfig({ ...config, query: range });
      const next = await call<StatisticsResult>("calculate", {
        range,
        departmentIds: departments,
      });
      setResult(next);
      setPage(0);
      setPersonId("");
      if (config.rules.debugDetailsEnabled) setTab("details");
      notify(
        `统计完成，共 ${next.rows.length} 位人员、${next.details.length} 条每日明细。`,
      );
    });
  }
  async function exportReport() {
    await run("正在导出报表…", async () => {
      const path = await saveFile(weekName(range.startDate), "xlsx");
      if (!path) return;
      const count = await call<number>("export_statistics", {
        path,
        range,
        departmentIds: departments,
      });
      notify(`已导出 ${count} 位人员的统计和每日明细：${path}`);
    });
  }
  async function monthly() {
    await run("正在汇总月报…", async () => {
      const files = await chooseFile(
        "选择需要汇总的周报（支持旧版）",
        ["xlsx"],
        true,
      );
      if (!files || (Array.isArray(files) && files.length === 0)) return;
      const [year, month] = range.startDate.split("-");
      const path = await saveFile(
        `${year}年${Number(month)}月总表.xlsx`,
        "xlsx",
      );
      if (!path) return;
      const count = await call<number>("merge_monthly", {
        paths: Array.isArray(files) ? files : [files],
        path,
      });
      notify(`月报已生成，共 ${count} 位人员：${path}`);
    });
  }
  const totals = useMemo(
    () =>
      result?.rows.reduce(
        (a, r) => ({
          expected: a.expected + r.expectedDays,
          actual: a.actual + r.actualDays,
          late: a.late + r.lateCount + r.earlyLeaveCount,
          absent: a.absent + r.absentDays,
          hours: a.hours + r.attendanceHours,
        }),
        { expected: 0, actual: 0, late: 0, absent: 0, hours: 0 },
      ),
    [result],
  );
  const rows = useMemo(() => {
    const rows = (result?.rows ?? []).filter(
      (r) =>
        `${r.personName}${r.deviceUserId}${r.departmentName}`
          .toLowerCase()
          .includes(search.toLowerCase()) &&
        (!onlyAbnormal ||
          r.absentDays > 0 ||
          r.lateCount > 0 ||
          r.earlyLeaveCount > 0),
    );
    if (sort === "hours")
      rows.sort((a, b) => b.attendanceHours - a.attendanceHours);
    if (sort === "name")
      rows.sort((a, b) => a.personName.localeCompare(b.personName, "zh-CN"));
    return rows;
  }, [result, search, sort, onlyAbnormal]);
  const details = (result?.details ?? []).filter(
    (d) =>
      (!personId || d.deviceUserId === personId) &&
      `${d.personName}${d.deviceUserId}${d.departmentName}${d.date}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (!onlyAbnormal || [...d.late, ...d.early, ...d.absent].some(Boolean)),
  );
  async function saveReview(review: Review) {
    await run("正在保存人工修正…", async () => {
      await call("save_review", { review });
      await refresh();
      const updated = await call<StatisticsResult>("calculate", {
        range,
        departmentIds: departments,
      });
      setResult(updated);
      setEdit(null);
      notify("修正已保存，统计已重新计算。");
    });
  }
  const cards = [
    {
      label: "统计人员",
      value: result ? number(result.rows.length) : number(config.people.length),
      unit: "人",
      detail: result ? "当前日期与部门范围" : "已建立人员档案",
      icon: Users,
      tone: "green",
    },
    {
      label: "实际出勤",
      value: totals ? number(totals.actual) : "—",
      unit: "人天",
      detail: totals
        ? `应到 ${number(totals.expected)} 人天`
        : "计算后查看出勤情况",
      icon: UserCheck,
      tone: "blue",
    },
    {
      label: "缺勤天数",
      value: totals ? number(totals.absent) : "—",
      unit: "人天",
      detail: totals ? `迟到 / 早退共 ${totals.late} 次` : "关注团队出勤异常",
      icon: CalendarCheck2,
      tone: "amber",
    },
    {
      label: "累计工时",
      value: totals ? number(totals.hours) : "—",
      unit: "小时",
      detail: "按有效打卡与人工修正计算",
      icon: Clock3,
      tone: "purple",
    },
  ];
  return (
    <>
      <div className="metric-grid">
        {cards.map((c) => (
          <div className="metric-card" key={c.label}>
            <div className="metric-label">
              {c.label}
              <span className={`metric-icon ${c.tone}`}>
                <c.icon size={18} />
              </span>
            </div>
            <div className="metric-value">
              {c.value}
              <span>{c.unit}</span>
            </div>
            <div className="metric-detail">{c.detail}</div>
          </div>
        ))}
      </div>
      <div className="filter-bar">
        <RangePicker range={range} onChange={setRange} />
        <DepartmentFilter selected={departments} onChange={setDepartments} />
        <button className="button primary" onClick={() => void calculate()}>
          <Calculator size={16} />
          计算统计
        </button>
      </div>
      <section className="panel statistics-panel">
        <div className="panel-toolbar">
          <div className="tabs">
            <button
              className={tab === "summary" ? "active" : ""}
              onClick={() => setTab("summary")}
            >
              考勤统计{result && <span>{result.rows.length}</span>}
            </button>
            <button
              className={tab === "details" ? "active" : ""}
              onClick={() => setTab("details")}
            >
              每日明细{result && <span>{result.details.length}</span>}
            </button>
          </div>
          <div className="toolbar-actions">
            <button className="button small" onClick={() => void monthly()}>
              <FileSpreadsheet size={15} />
              汇总月报
            </button>
            <button
              className="button small"
              disabled={!result?.rows.length}
              onClick={() => void exportReport()}
            >
              <ArrowDownToLine size={15} />
              导出 Excel
            </button>
          </div>
        </div>
        {result ? (
          <>
            <div className="table-tools">
              <label className="search-input">
                <Search size={16} />
                <input
                  aria-label="搜索考勤"
                  placeholder="搜索姓名、设备 ID 或部门…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button
                    className="icon-button"
                    aria-label="清空搜索"
                    onClick={() => setSearch("")}
                  >
                    <X size={14} />
                  </button>
                )}
              </label>
              <div className="inline-controls">
                {personId && (
                  <button
                    className="filter-chip"
                    onClick={() => setPersonId("")}
                  >
                    仅当前人员
                    <X size={13} />
                  </button>
                )}
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={onlyAbnormal}
                    onChange={(e) => setOnlyAbnormal(e.target.checked)}
                  />
                  仅看异常
                </label>
                {tab === "summary" && (
                  <select
                    aria-label="统计排序"
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                  >
                    <option value="department">按部门 · 工时</option>
                    <option value="hours">工时从高到低</option>
                    <option value="name">按姓名排序</option>
                  </select>
                )}
              </div>
            </div>
            {result.warnings.length > 0 && (
              <details className="warnings">
                <summary>
                  <Info size={15} />
                  {result.warnings[0]}
                  {result.warnings.length > 1 && (
                    <span>另 {result.warnings.length - 1} 项提示</span>
                  )}
                  <ChevronDown size={14} />
                </summary>
                {result.warnings.slice(1).map((w) => (
                  <p key={w}>{w}</p>
                ))}
              </details>
            )}
            {(tab === "summary" ? rows.length : details.length) === 0 ? (
              <Empty
                title="没有符合条件的考勤"
                description="请检查人员班次、日期范围或搜索条件。"
              />
            ) : (
              <div className="table-scroll">
                <table>
                  {tab === "summary" ? (
                    <>
                      <thead>
                        <tr>
                          <th>人员</th>
                          <th>部门</th>
                          <th className="numeric">应到 / 天</th>
                          <th className="numeric">实到 / 天</th>
                          <th className="numeric">迟到 / 次</th>
                          <th className="numeric">早退 / 次</th>
                          <th className="numeric">缺勤 / 天</th>
                          <th className="numeric">工时 / 时</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {rows.slice(page * size, (page + 1) * size).map((r) => (
                          <tr key={r.deviceUserId}>
                            <td>
                              <div className="person-cell">
                                <span className="person-avatar">
                                  {r.personName.slice(-2)}
                                </span>
                                <div>
                                  <strong>{r.personName}</strong>
                                  <small>
                                    ID {r.deviceUserId}
                                    {r.grade && ` · ${r.grade}`}
                                  </small>
                                </div>
                              </div>
                            </td>
                            <td>
                              <span className="department-tag">
                                {r.departmentName}
                              </span>
                            </td>
                            <td className="numeric muted">
                              {number(r.expectedDays)}
                            </td>
                            <td className="numeric strong">
                              {number(r.actualDays)}
                            </td>
                            <td className="numeric">
                              {r.lateCount ? (
                                <Badge tone="amber">{r.lateCount}</Badge>
                              ) : (
                                <span className="muted">0</span>
                              )}
                            </td>
                            <td className="numeric">
                              {r.earlyLeaveCount ? (
                                <Badge tone="green">{r.earlyLeaveCount}</Badge>
                              ) : (
                                <span className="muted">0</span>
                              )}
                            </td>
                            <td className="numeric">
                              {r.absentDays ? (
                                <Badge tone="red">{number(r.absentDays)}</Badge>
                              ) : (
                                <span className="muted">0</span>
                              )}
                            </td>
                            <td className="numeric strong">
                              {number(r.attendanceHours)}
                            </td>
                            <td>
                              <button
                                className="icon-button"
                                aria-label={`查看${r.personName}明细`}
                                onClick={() => {
                                  setPersonId(r.deviceUserId);
                                  setTab("details");
                                  setOnlyAbnormal(false);
                                }}
                              >
                                <ArrowRight size={17} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  ) : (
                    <>
                      <thead>
                        <tr>
                          <th>人员 / 日期</th>
                          <th>上午上班</th>
                          <th>上午下班</th>
                          <th>下午上班</th>
                          <th>下午下班</th>
                          <th>状态</th>
                          <th className="numeric">工时</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {details
                          .slice(page * size, (page + 1) * size)
                          .map((d) => (
                            <tr key={`${d.deviceUserId}-${d.date}`}>
                              <td>
                                <div className="detail-person">
                                  <strong>
                                    {d.personName}
                                    {d.reviewed && (
                                      <span title="已人工修正">
                                        <PencilLine size={12} />
                                      </span>
                                    )}
                                  </strong>
                                  <small>{d.date}</small>
                                </div>
                              </td>
                              {d.punches.map((p, i) => (
                                <td
                                  key={i}
                                  className={`punch ${i % 2 === 0 && d.late[Math.floor(i / 2)] ? "late-text" : ""} ${i % 2 === 1 && d.early[Math.floor(i / 2)] ? "early-text" : ""}`}
                                >
                                  {d.scheduled[i] === null ? (
                                    <span className="muted">—</span>
                                  ) : d.exempt[Math.floor(i / 2)] ? (
                                    <span className="muted">免考勤</span>
                                  ) : p ? (
                                    p.slice(0, 8)
                                  ) : (
                                    <span className="missing-punch">缺卡</span>
                                  )}
                                </td>
                              ))}
                              <td>
                                <div className="status-badges">
                                  {d.absent.some(Boolean) && (
                                    <Badge tone="red">缺勤</Badge>
                                  )}
                                  {d.late.some(Boolean) && (
                                    <Badge tone="amber">迟到</Badge>
                                  )}
                                  {d.early.some(Boolean) && (
                                    <Badge tone="green">早退</Badge>
                                  )}
                                  {![...d.absent, ...d.late, ...d.early].some(
                                    Boolean,
                                  ) && (
                                    <Badge tone="neutral">
                                      {d.exempt.every(Boolean)
                                        ? "免考勤"
                                        : "正常"}
                                    </Badge>
                                  )}
                                </div>
                              </td>
                              <td className="numeric">{number(d.hours)}</td>
                              <td>
                                <button
                                  className="icon-button"
                                  aria-label={`修正${d.personName}${d.date}`}
                                  onClick={() => setEdit(d)}
                                >
                                  <PencilLine size={16} />
                                </button>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </>
                  )}
                </table>
              </div>
            )}
            <Pagination
              page={page}
              total={tab === "summary" ? rows.length : details.length}
              size={size}
              setPage={setPage}
            />
          </>
        ) : (
          <Empty
            title={
              config.people.length
                ? "准备好，开始本次考勤统计"
                : "从你的第一位团队成员开始"
            }
            description={
              config.people.length
                ? "选择日期和部门后计算，原始打卡与已保存的人工修正将一起参与统计。"
                : "先导入旧版数据，或添加人员并分配班次，再同步考勤记录。"
            }
            action={
              <button
                className="button primary"
                onClick={() =>
                  config.people.length ? void calculate() : navigate("people")
                }
              >
                {config.people.length ? (
                  <Calculator size={16} />
                ) : (
                  <Users size={16} />
                )}{" "}
                {config.people.length ? "计算考勤" : "管理人员"}
                <ArrowRight size={16} />
              </button>
            }
          />
        )}
      </section>
      <div className="below-panel-note">
        <Info size={14} />
        上午、下午各计半天；单侧缺卡按班次时间补全工时。人工修正优先于自动计算。
      </div>
      {edit && (
        <ReviewEditor
          detail={edit}
          onClose={() => setEdit(null)}
          onSave={saveReview}
        />
      )}
    </>
  );
}
function ReviewEditor({
  detail,
  onSave,
  onClose,
}: {
  detail: Detail;
  onSave: (r: Review) => Promise<void>;
  onClose: () => void;
}) {
  const { busy } = useApp();
  const [review, setReview] = useState<Review>({
    deviceUserId: detail.deviceUserId,
    date: detail.date,
    punches: [...detail.punches],
    exempt: [...detail.exempt],
    note: detail.note,
  });
  return (
    <Modal
      title="修正每日考勤"
      subtitle={`${detail.personName} · ${detail.date} · ${detail.departmentName}`}
      onClose={() => !busy && onClose()}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(review);
        }}
      >
        <fieldset disabled={!!busy}>
          {[0, 1].map((half) => (
            <div className="review-period" key={half}>
              <div className="review-period-heading">
                <strong>{half === 0 ? "上午时段" : "下午时段"}</strong>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    disabled={detail.scheduled[half * 2] === null}
                    checked={review.exempt[half]}
                    onChange={(e) =>
                      setReview({
                        ...review,
                        exempt: review.exempt.map((value, i) =>
                          i === half ? e.target.checked : value,
                        ),
                      })
                    }
                  />
                  免考勤
                </label>
              </div>
              <div className="form-grid">
                {[0, 1].map((offset) => {
                  const i = half * 2 + offset;
                  return (
                    <Field
                      key={i}
                      label={offset === 0 ? "上班打卡" : "下班打卡"}
                      hint={`计划 ${detail.scheduled[i]?.slice(0, 5) ?? "休息"}`}
                    >
                      <input
                        aria-label={`${half === 0 ? "上午" : "下午"}${offset === 0 ? "上班" : "下班"}打卡`}
                        type="time"
                        step="1"
                        disabled={
                          review.exempt[half] || detail.scheduled[i] === null
                        }
                        value={review.punches[i] ?? ""}
                        onChange={(e) =>
                          setReview({
                            ...review,
                            punches: review.punches.map((value, index) =>
                              index === i
                                ? e.target.value
                                  ? e.target.value.length === 5
                                    ? `${e.target.value}:00`
                                    : e.target.value
                                  : null
                                : value,
                            ),
                          })
                        }
                      />
                    </Field>
                  );
                })}
              </div>
            </div>
          ))}
          <Field label="修正备注">
            <textarea
              placeholder="例如：忘记打卡、下午请假、调休…"
              rows={3}
              maxLength={1000}
              value={review.note}
              onChange={(e) => setReview({ ...review, note: e.target.value })}
            />
          </Field>
          <div className="info-note">
            <History size={16} />
            原始记录会保留，可在「规则与数据」撤销此日期范围的修正。
          </div>
          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose}>
              取消
            </button>
            <button className="button primary" type="submit">
              <Check size={16} />
              保存并重新计算
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}

export function LogsPage() {
  const { boot, range, setRange, dataVersion, run, notify, refresh, navigate } =
    useApp();
  const [search, setSearch] = useState(""),
    [debounced, setDebounced] = useState(""),
    [departments, setDepartments] = useState<string[]>([]),
    [page, setPage] = useState(0);
  const [data, setData] = useState<LogPage | null>(null),
    [error, setError] = useState("");
  const query: LogQuery = useMemo(
    () => ({
      range,
      search: debounced,
      departmentIds: departments,
      page,
      pageSize: 30,
    }),
    [range, debounced, departments, page],
  );
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 200);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    setPage(0);
  }, [range, debounced, departments]);
  useEffect(() => {
    let active = true;
    setData(null);
    setError("");
    call<LogPage>("query_logs", { query })
      .then((result) => {
        if (active) setData(result);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [query, dataVersion]);
  async function importCsv() {
    await run("正在导入原始记录…", async () => {
      const path = await chooseFile("导入打卡 CSV", ["csv"]);
      if (typeof path !== "string") return;
      const report = await call<ImportSummary>("import_logs", { path });
      await refresh();
      notify(
        `已导入 ${report.added} 条记录，跳过 ${report.skipped} 条重复记录。`,
      );
    });
  }
  async function exportCsv() {
    await run("正在导出 CSV…", async () => {
      const path = await saveFile(
        `打卡记录_${range.startDate}_${range.endDate}.csv`,
        "csv",
      );
      if (!path) return;
      const count = await call<number>("export_logs", { path, query });
      notify(`已导出当前筛选的 ${count} 条记录：${path}`);
    });
  }
  return (
    <>
      <div className="section-intro">
        <div>
          <h2>
            原始打卡日志{" "}
            <span className="count-label">{number(boot.logCount)}</span>
          </h2>
          <p>保留每条设备记录，重复导入或下载自动去重。</p>
        </div>
        <div className="toolbar-actions">
          <button className="button" onClick={() => void importCsv()}>
            <Upload size={16} />
            导入 CSV
          </button>
          <button className="button primary" onClick={() => navigate("device")}>
            <Download size={16} />
            从设备下载
          </button>
        </div>
      </div>
      <div className="filter-bar">
        <RangePicker range={range} onChange={setRange} />
        <DepartmentFilter selected={departments} onChange={setDepartments} />
        <button
          className="button"
          disabled={!data?.total}
          onClick={() => void exportCsv()}
        >
          <ArrowDownToLine size={16} />
          导出 CSV
        </button>
      </div>
      <section className="panel">
        <div className="table-tools">
          <label className="search-input">
            <Search size={16} />
            <input
              aria-label="搜索原始记录"
              value={search}
              placeholder="搜索姓名、设备 ID 或部门…"
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <span className="subtle">按打卡时间倒序</span>
        </div>
        {error ? (
          <div className="inline-error" role="alert">
            {error}
          </div>
        ) : !data ? (
          <Loading />
        ) : data.records.length === 0 ? (
          <Empty
            title="当前范围还没有打卡记录"
            description="连接考勤机下载记录，或导入旧版导出的 CSV 文件。"
            action={
              <button className="button" onClick={() => void importCsv()}>
                <Upload size={16} />
                导入 CSV
              </button>
            }
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>人员</th>
                  <th>设备 ID</th>
                  <th>部门</th>
                  <th>打卡时间</th>
                  <th>验证方式</th>
                  <th>打卡状态</th>
                  <th>工作代码</th>
                </tr>
              </thead>
              <tbody>
                {data.records.map((log) => (
                  <tr key={log.id}>
                    <td className="strong">{log.personName}</td>
                    <td className="mono muted">{log.userId}</td>
                    <td>
                      <span className="department-tag">
                        {log.departmentName}
                      </span>
                    </td>
                    <td className="mono">{log.timestamp.replace("T", " ")}</td>
                    <td>
                      {(
                        {
                          0: "密码",
                          1: "指纹",
                          2: "卡片",
                          3: "密码 / 指纹",
                          15: "人脸",
                        } as Record<number, string>
                      )[log.verifyMode] ?? `方式 ${log.verifyMode}`}
                      <small className="code-hint">{log.verifyMode}</small>
                    </td>
                    <td>
                      {(
                        {
                          0: "签到",
                          1: "签退",
                          2: "外出",
                          3: "返回",
                          4: "加班签到",
                          5: "加班签退",
                        } as Record<number, string>
                      )[log.inOutMode] ?? `状态 ${log.inOutMode}`}
                    </td>
                    <td className="mono muted">{log.workCode}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && (
          <Pagination
            page={page}
            total={data.total}
            size={30}
            setPage={setPage}
          />
        )}
      </section>
      <div className="below-panel-note">
        <Info size={14} />
        CSV 支持 UTF-8 / GB18030，必须包含 UserId 和 Timestamp
        列。时间使用考勤机本地时间。
      </div>
    </>
  );
}
