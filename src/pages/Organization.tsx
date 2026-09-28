import { useEffect, useMemo, useState } from "react";
import {
  Building2,
  Check,
  Copy,
  FolderPlus,
  Info,
  PencilLine,
  Plus,
  Save,
  Search,
  Trash2,
  Upload,
  UserPlus,
  Users,
} from "lucide-react";
import { call, chooseFile, newShift, number } from "../api";
import { Badge, Empty, Field, Modal, Pagination } from "../components";
import { useApp } from "../context";
import type {
  Department,
  ImportSummary,
  Person,
  Shift,
  ShiftDay,
} from "../types";

export function PeoplePage() {
  const { config, run, saveConfig, confirm, refresh, notify, busy } = useApp();
  const [department, setDepartment] = useState(""),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(0);
  const [person, setPerson] = useState<Person | null>(null),
    [deptEditor, setDeptEditor] = useState<Department | null>(null),
    [selected, setSelected] = useState<string[]>([]);
  const [bulk, setBulk] = useState(false),
    [bulkDept, setBulkDept] = useState("__keep"),
    [bulkShift, setBulkShift] = useState("__keep");
  const [importDept, setImportDept] = useState<string | null>(null);
  const filtered = useMemo(
    () =>
      config.people.filter(
        (p) =>
          (!department || p.departmentId === department) &&
          `${p.fullName}${p.deviceUserId}${p.grade}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [config, department, search],
  );
  useEffect(() => {
    setPage(0);
    setSelected([]);
  }, [department, search, config.revision]);
  const system = config.departments.find((d) => d.isSystem)!;
  const selectedDept = config.departments.find((d) => d.id === department);
  function createPerson() {
    setPerson({
      id: crypto.randomUUID(),
      deviceUserId: "",
      fullName: "",
      grade: "",
      departmentId: department || system.id,
      shiftId: null,
    });
  }
  async function savePerson() {
    if (!person) return;
    await run(
      "正在保存人员…",
      async () => {
        const existing = config.people.some((p) => p.id === person.id);
        await saveConfig({
          ...config,
          people: existing
            ? config.people.map((p) => (p.id === person.id ? person : p))
            : [...config.people, person],
        });
        setPerson(null);
      },
      "人员信息已保存",
    );
  }
  async function saveDepartment() {
    if (!deptEditor) return;
    await run(
      "正在保存部门…",
      async () => {
        await saveConfig({
          ...config,
          departments: config.departments.some((d) => d.id === deptEditor.id)
            ? config.departments.map((d) =>
                d.id === deptEditor.id ? deptEditor : d,
              )
            : [...config.departments, deptEditor],
        });
        setDepartment(deptEditor.id);
        setDeptEditor(null);
      },
      "部门已保存",
    );
  }
  function deleteDepartment() {
    if (!selectedDept || selectedDept.isSystem) return;
    confirm(
      `删除「${selectedDept.name}」`,
      "该部门中的人员将自动转入「未分类」。人员和原始打卡记录会保留。",
      async () => {
        await saveConfig({
          ...config,
          departments: config.departments.filter((d) => d.id !== department),
          people: config.people.map((p) =>
            p.departmentId === department
              ? { ...p, departmentId: system.id }
              : p,
          ),
        });
        setDepartment("");
        notify("部门已删除，所属人员已转入未分类。");
      },
    );
  }
  function deletePerson(p: Person) {
    confirm(
      `删除人员「${p.fullName}」`,
      `将删除设备 ID ${p.deviceUserId} 的人员映射。原始记录和历史修正会保留，该人员将不再参与统计。`,
      async () => {
        await saveConfig({
          ...config,
          people: config.people.filter((item) => item.id !== p.id),
        });
        setPerson(null);
        notify("人员映射已删除。");
      },
    );
  }
  async function importPeople() {
    if (!importDept) return;
    await run("正在导入人员…", async () => {
      const path = await chooseFile("导入人员名单", ["txt", "csv", "tsv"]);
      if (typeof path !== "string") return;
      const result = await call<ImportSummary>("import_people", {
        path,
        departmentId: importDept,
      });
      await refresh();
      setImportDept(null);
      notify(
        `新增 ${result.added} 人，更新 ${result.updated} 人，跳过 ${result.skipped} 行。${result.warnings.join("；")}`,
        result.skipped > 0,
      );
    });
  }
  return (
    <>
      <div className="section-intro">
        <div>
          <h2>
            团队成员 <span className="count-label">{config.people.length}</span>
          </h2>
          <p>
            {config.departments.length} 个部门 ·{" "}
            {config.people.filter((p) => !p.shiftId).length} 位人员待分配班次
          </p>
        </div>
        <div className="toolbar-actions">
          <button
            className="button"
            onClick={() => setImportDept(department || system.id)}
          >
            <Upload size={16} />
            导入名单
          </button>
          <button className="button primary" onClick={createPerson}>
            <UserPlus size={16} />
            添加人员
          </button>
        </div>
      </div>
      <div className="organization-layout">
        <section className="panel department-panel">
          <div className="compact-heading">
            <h3>部门</h3>
            <button
              className="icon-button"
              aria-label="添加部门"
              onClick={() =>
                setDeptEditor({
                  id: crypto.randomUUID(),
                  name: "",
                  isSystem: false,
                })
              }
            >
              <FolderPlus size={18} />
            </button>
          </div>
          <button
            className={`department-row ${!department ? "selected" : ""}`}
            onClick={() => setDepartment("")}
          >
            <Users size={16} />
            <span>全部人员</span>
            <small>{config.people.length}</small>
          </button>
          {config.departments.map((d) => (
            <button
              className={`department-row ${department === d.id ? "selected" : ""}`}
              onClick={() => setDepartment(d.id)}
              key={d.id}
            >
              <Building2 size={16} />
              <span>{d.name}</span>
              <small>
                {config.people.filter((p) => p.departmentId === d.id).length}
              </small>
            </button>
          ))}
          <button
            className="add-department"
            onClick={() =>
              setDeptEditor({
                id: crypto.randomUUID(),
                name: "",
                isSystem: false,
              })
            }
          >
            <Plus size={15} />
            新建部门
          </button>
        </section>
        <section className="panel people-panel">
          <div className="table-tools">
            <label className="search-input">
              <Search size={16} />
              <input
                aria-label="搜索人员"
                placeholder="搜索姓名、设备 ID、年级…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            {selectedDept && (
              <div className="inline-controls">
                <button
                  className="icon-button"
                  title="重命名部门"
                  aria-label="重命名部门"
                  onClick={() => setDeptEditor({ ...selectedDept })}
                >
                  <PencilLine size={16} />
                </button>
                <button
                  className="icon-button danger"
                  title={
                    selectedDept.isSystem ? "系统部门不可删除" : "删除部门"
                  }
                  aria-label="删除部门"
                  disabled={selectedDept.isSystem}
                  onClick={deleteDepartment}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            )}
          </div>
          {selected.length > 0 && (
            <div className="selection-bar">
              <Check size={16} />
              <span>已选择 {selected.length} 位人员</span>
              <button
                className="text-button"
                onClick={() => {
                  setBulkDept("__keep");
                  setBulkShift("__keep");
                  setBulk(true);
                }}
              >
                批量分配部门 / 班次
              </button>
              <button className="text-button" onClick={() => setSelected([])}>
                取消选择
              </button>
            </div>
          )}
          {filtered.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th className="checkbox-cell">
                      <input
                        type="checkbox"
                        aria-label="选择当前筛选的全部人员"
                        checked={
                          filtered.length > 0 &&
                          filtered.every((p) => selected.includes(p.id))
                        }
                        onChange={(e) =>
                          setSelected(
                            e.target.checked ? filtered.map((p) => p.id) : [],
                          )
                        }
                      />
                    </th>
                    <th>人员</th>
                    <th>部门</th>
                    <th>年级 / 备注</th>
                    <th>考勤班次</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(page * 20, (page + 1) * 20).map((p) => (
                    <tr key={p.id}>
                      <td className="checkbox-cell">
                        <input
                          type="checkbox"
                          aria-label={`选择${p.fullName}`}
                          checked={selected.includes(p.id)}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...selected, p.id]
                                : selected.filter((id) => id !== p.id),
                            )
                          }
                        />
                      </td>
                      <td>
                        <div className="person-cell">
                          <span className="person-avatar">
                            {p.fullName.slice(-2)}
                          </span>
                          <div>
                            <strong>{p.fullName}</strong>
                            <small>ID {p.deviceUserId}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className="department-tag">
                          {
                            config.departments.find(
                              (d) => d.id === p.departmentId,
                            )?.name
                          }
                        </span>
                      </td>
                      <td className="muted">{p.grade || "—"}</td>
                      <td>
                        {p.shiftId ? (
                          <span className="shift-tag">
                            <span />
                            {
                              config.shifts.find((s) => s.id === p.shiftId)
                                ?.name
                            }
                          </span>
                        ) : (
                          <Badge tone="amber">待分配</Badge>
                        )}
                      </td>
                      <td>
                        <button
                          className="icon-button"
                          aria-label={`编辑${p.fullName}`}
                          onClick={() => setPerson({ ...p })}
                        >
                          <PencilLine size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title={search ? "没有找到匹配人员" : "这个部门还没有成员"}
              description="添加人员时，设备 ID 需要与考勤机上的人员编号一致。"
              action={
                <button className="button" onClick={createPerson}>
                  <Plus size={16} />
                  添加人员
                </button>
              }
            />
          )}
          <Pagination
            page={page}
            total={filtered.length}
            size={20}
            setPage={setPage}
          />
        </section>
      </div>
      <div className="below-panel-note">
        <Info size={14} />
        每个人属于一个部门，最多绑定一个班次。未分配班次的人员不参与考勤统计。
      </div>
      {person && (
        <Modal
          title={
            config.people.some((p) => p.id === person.id)
              ? "编辑人员"
              : "添加人员"
          }
          subtitle="将设备上的打卡编号关联到团队成员"
          onClose={() => !busy && setPerson(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void savePerson();
            }}
          >
            <fieldset disabled={!!busy}>
              <div className="form-grid">
                <Field label="姓名">
                  <input
                    required
                    autoFocus
                    value={person.fullName}
                    onChange={(e) =>
                      setPerson({ ...person, fullName: e.target.value })
                    }
                    placeholder="请输入姓名"
                  />
                </Field>
                <Field label="设备 ID" hint="保留前导零，如 001">
                  <input
                    required
                    maxLength={128}
                    value={person.deviceUserId}
                    onChange={(e) =>
                      setPerson({ ...person, deviceUserId: e.target.value })
                    }
                    placeholder="考勤机人员编号"
                  />
                </Field>
                <Field label="所属部门">
                  <select
                    value={person.departmentId}
                    onChange={(e) =>
                      setPerson({ ...person, departmentId: e.target.value })
                    }
                  >
                    {config.departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="考勤班次">
                  <select
                    value={person.shiftId ?? ""}
                    onChange={(e) =>
                      setPerson({ ...person, shiftId: e.target.value || null })
                    }
                  >
                    <option value="">暂不分配</option>
                    {config.shifts.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="年级 / 备注">
                <input
                  value={person.grade}
                  onChange={(e) =>
                    setPerson({ ...person, grade: e.target.value })
                  }
                  placeholder="选填"
                />
              </Field>
              <div className="modal-actions">
                {config.people.some((p) => p.id === person.id) && (
                  <button
                    type="button"
                    className="button danger push-left"
                    onClick={() => deletePerson(person)}
                  >
                    <Trash2 size={15} />
                    删除人员
                  </button>
                )}
                <button
                  type="button"
                  className="button"
                  onClick={() => setPerson(null)}
                >
                  取消
                </button>
                <button type="submit" className="button primary">
                  <Save size={16} />
                  保存人员
                </button>
              </div>
            </fieldset>
          </form>
        </Modal>
      )}
      {deptEditor && (
        <Modal
          title={
            config.departments.some((d) => d.id === deptEditor.id)
              ? "重命名部门"
              : "新建部门"
          }
          onClose={() => !busy && setDeptEditor(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveDepartment();
            }}
          >
            <fieldset disabled={!!busy}>
              <Field label="部门名称">
                <input
                  required
                  autoFocus
                  value={deptEditor.name}
                  onChange={(e) =>
                    setDeptEditor({ ...deptEditor, name: e.target.value })
                  }
                  placeholder="例如：研发部"
                />
              </Field>
              <div className="modal-actions">
                <button
                  type="button"
                  className="button"
                  onClick={() => setDeptEditor(null)}
                >
                  取消
                </button>
                <button className="button primary" type="submit">
                  保存部门
                </button>
              </div>
            </fieldset>
          </form>
        </Modal>
      )}
      {importDept && (
        <Modal
          title="导入人员名单"
          subtitle="支持 TXT、CSV、TSV，自动识别 UTF-8 和 GB18030"
          onClose={() => !busy && setImportDept(null)}
        >
          <Field label="导入到部门">
            <select
              value={importDept}
              onChange={(e) => setImportDept(e.target.value)}
            >
              {config.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="code-sample">
            001 张三
            <br />
            002 李四
            <br />
            003 王五
          </div>
          <p className="subtle">
            每行填写设备 ID 与姓名，可用空格、制表符、逗号分隔。相同 ID
            会更新姓名和部门，保留已分配的班次。
          </p>
          <div className="modal-actions">
            <button
              className="button"
              disabled={!!busy}
              onClick={() => setImportDept(null)}
            >
              取消
            </button>
            <button
              className="button primary"
              disabled={!!busy}
              onClick={() => void importPeople()}
            >
              <Upload size={16} />
              选择文件并导入
            </button>
          </div>
        </Modal>
      )}
      {bulk && (
        <Modal
          title={`批量调整 ${selected.length} 位人员`}
          onClose={() => !busy && setBulk(false)}
        >
          <div className="form-grid">
            <Field label="部门">
              <select
                value={bulkDept}
                onChange={(e) => setBulkDept(e.target.value)}
              >
                <option value="__keep">保持原部门</option>
                {config.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="班次">
              <select
                value={bulkShift}
                onChange={(e) => setBulkShift(e.target.value)}
              >
                <option value="__keep">保持原班次</option>
                <option value="">取消班次分配</option>
                {config.shifts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="modal-actions">
            <button
              className="button"
              disabled={!!busy}
              onClick={() => setBulk(false)}
            >
              取消
            </button>
            <button
              className="button primary"
              disabled={!!busy}
              onClick={() =>
                void run(
                  "正在批量分配…",
                  async () => {
                    await saveConfig({
                      ...config,
                      people: config.people.map((p) =>
                        selected.includes(p.id)
                          ? {
                              ...p,
                              departmentId:
                                bulkDept === "__keep"
                                  ? p.departmentId
                                  : bulkDept,
                              shiftId:
                                bulkShift === "__keep"
                                  ? p.shiftId
                                  : bulkShift || null,
                            }
                          : p,
                      ),
                    });
                    setBulk(false);
                  },
                  "批量分配已保存",
                )
              }
            >
              确认分配
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

const dayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
export function ShiftsPage() {
  const { config, saveConfig, run, confirm, notify } = useApp();
  const [draft, setDraft] = useState<Shift | null>(() =>
    config.shifts[0] ? structuredClone(config.shifts[0]) : null,
  );
  const original = config.shifts.find((s) => s.id === draft?.id);
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(original);
  const users = config.people.filter((p) => p.shiftId === draft?.id).length;
  function select(shift: Shift) {
    if (dirty)
      confirm(
        "放弃未保存的班次修改",
        "当前班次有未保存的内容，继续后将切换到所选班次。",
        async () => setDraft(structuredClone(shift)),
      );
    else setDraft(structuredClone(shift));
  }
  function add() {
    select(newShift());
  }
  function changeDay(day: number, patch: Partial<ShiftDay>) {
    if (draft)
      setDraft({
        ...draft,
        days: draft.days.map((d) =>
          d.dayOfWeek === day ? { ...d, ...patch } : d,
        ),
      });
  }
  async function save() {
    if (!draft) return;
    await run(
      "正在保存班次…",
      async () => {
        const saved = await saveConfig({
          ...config,
          shifts: original
            ? config.shifts.map((s) => (s.id === draft.id ? draft : s))
            : [...config.shifts, draft],
        });
        setDraft(structuredClone(saved.shifts.find((s) => s.id === draft.id)!));
      },
      "班次安排已保存",
    );
  }
  function remove() {
    if (!draft || users) return;
    confirm(
      `删除班次「${draft.name}」`,
      "删除后可重新创建班次。已被人员使用的班次需要先解除分配。",
      async () => {
        const shifts = config.shifts.filter((s) => s.id !== draft.id);
        await saveConfig({ ...config, shifts });
        setDraft(shifts[0] ? structuredClone(shifts[0]) : null);
        notify("班次已删除。");
      },
    );
  }
  const hours =
    draft?.days.reduce((total, d) => {
      const minutes = (time: string) => {
        const [h, m] = time.split(":").map(Number);
        return h * 60 + m;
      };
      return (
        total +
        (d.morningEnabled
          ? Math.max(0, minutes(d.morningEnd) - minutes(d.morningStart))
          : 0) +
        (d.afternoonEnabled
          ? Math.max(0, minutes(d.afternoonEnd) - minutes(d.afternoonStart))
          : 0)
      );
    }, 0) ?? 0;
  return (
    <>
      <div className="section-intro">
        <div>
          <h2>
            每周班次安排{" "}
            <span className="count-label">{config.shifts.length}</span>
          </h2>
          <p>一个班次，一周七天，每天两个考勤时段。</p>
        </div>
        <button className="button primary" onClick={add}>
          <Plus size={16} />
          新建班次
        </button>
      </div>
      <div className="shift-layout">
        <section className="panel shift-list">
          <div className="compact-heading">
            <h3>全部班次</h3>
            <span className="subtle">{config.shifts.length}</span>
          </div>
          {config.shifts.map((s) => (
            <button
              className={`shift-list-item ${draft?.id === s.id ? "selected" : ""}`}
              onClick={() => select(s)}
              key={s.id}
            >
              <strong>{s.name}</strong>
              <span>
                {
                  s.days.filter((d) => d.morningEnabled || d.afternoonEnabled)
                    .length
                }{" "}
                天 / 周 ·{" "}
                {config.people.filter((p) => p.shiftId === s.id).length} 人使用
              </span>
            </button>
          ))}
          {config.shifts.length === 0 && (
            <p className="list-empty">还没有班次，点击右上角新建。</p>
          )}
        </section>
        <section className="panel shift-editor">
          {draft ? (
            <>
              <div className="shift-editor-header">
                <div>
                  <div className="inline-controls">
                    <h3>{original ? "编辑班次" : "新班次"}</h3>
                    {dirty && <Badge tone="amber">未保存</Badge>}
                  </div>
                  <p>
                    每周计划 {number(hours / 60)} 小时 · {users} 人使用
                  </p>
                </div>
                <div className="toolbar-actions">
                  <button
                    className="icon-button"
                    title="复制班次"
                    aria-label="复制班次"
                    onClick={() =>
                      select({
                        ...structuredClone(draft),
                        id: crypto.randomUUID(),
                        name: `${draft.name} 副本`,
                      })
                    }
                  >
                    <Copy size={17} />
                  </button>
                  <button
                    className="icon-button danger"
                    title={users ? "请先解除人员的班次分配" : "删除班次"}
                    aria-label="删除班次"
                    disabled={!!users || !original}
                    onClick={remove}
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>
              <div className="shift-name">
                <Field label="班次名称">
                  <input
                    value={draft.name}
                    onChange={(e) =>
                      setDraft({ ...draft, name: e.target.value })
                    }
                    placeholder="例如：标准工作日"
                  />
                </Field>
                <button
                  className="button small"
                  onClick={() => {
                    const monday = draft.days.find((d) => d.dayOfWeek === 1)!;
                    setDraft({
                      ...draft,
                      days: draft.days.map((d) =>
                        d.dayOfWeek >= 1 && d.dayOfWeek <= 5
                          ? { ...monday, dayOfWeek: d.dayOfWeek }
                          : d,
                      ),
                    });
                  }}
                >
                  <Copy size={14} />
                  周一安排应用到工作日
                </button>
              </div>
              <div className="table-scroll">
                <table className="schedule-table">
                  <thead>
                    <tr>
                      <th>星期</th>
                      <th>上午时段</th>
                      <th>下午时段</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[1, 2, 3, 4, 5, 6, 0].map((day) => {
                      const d = draft.days.find(
                        (item) => item.dayOfWeek === day,
                      )!;
                      return (
                        <tr
                          key={day}
                          className={
                            !d.morningEnabled && !d.afternoonEnabled
                              ? "rest-day"
                              : ""
                          }
                        >
                          <td>
                            <strong>{dayNames[day]}</strong>
                            {(day === 0 || day === 6) && <small>周末</small>}
                          </td>
                          {(["morning", "afternoon"] as const).map((period) => (
                            <td key={period}>
                              <div className="schedule-period">
                                <input
                                  type="checkbox"
                                  aria-label={`${dayNames[day]}${period === "morning" ? "上午" : "下午"}启用`}
                                  checked={d[`${period}Enabled`]}
                                  onChange={(e) =>
                                    changeDay(day, {
                                      [`${period}Enabled`]: e.target.checked,
                                    })
                                  }
                                />
                                <input
                                  type="time"
                                  aria-label={`${dayNames[day]}${period === "morning" ? "上午" : "下午"}上班`}
                                  disabled={!d[`${period}Enabled`]}
                                  value={d[`${period}Start`]}
                                  onChange={(e) =>
                                    changeDay(day, {
                                      [`${period}Start`]: e.target.value,
                                    })
                                  }
                                />
                                <span>—</span>
                                <input
                                  type="time"
                                  aria-label={`${dayNames[day]}${period === "morning" ? "上午" : "下午"}下班`}
                                  disabled={!d[`${period}Enabled`]}
                                  value={d[`${period}End`]}
                                  onChange={(e) =>
                                    changeDay(day, {
                                      [`${period}End`]: e.target.value,
                                    })
                                  }
                                />
                              </div>
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="shift-editor-footer">
                <span>
                  <Info size={14} />
                  取消勾选即为该时段休息
                </span>
                <button
                  className="button primary"
                  disabled={!dirty}
                  onClick={() => void save()}
                >
                  <Save size={16} />
                  保存班次
                </button>
              </div>
            </>
          ) : (
            <Empty
              title="创建一份周班次"
              description="设置工作时间后，可以在人员页批量分配给团队成员。"
              action={
                <button className="button primary" onClick={add}>
                  <Plus size={16} />
                  新建班次
                </button>
              }
            />
          )}
        </section>
      </div>
      <div className="below-panel-note">
        <Info size={14} />
        打卡识别窗口在「规则与数据」统一设置。调整班次时，请同时确认打卡窗口涵盖新时间。
      </div>
    </>
  );
}
