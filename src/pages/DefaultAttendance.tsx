import { useState } from "react";
import { Check, Info, PencilLine, Trash2 } from "lucide-react";
import { Field, Modal } from "../components";
import { useApp } from "../context";
import type { DefaultAttendancePeriod } from "../types";

const weekdays = [
  { day: 1, label: "周一" },
  { day: 2, label: "周二" },
  { day: 3, label: "周三" },
  { day: 4, label: "周四" },
  { day: 5, label: "周五" },
  { day: 6, label: "周六" },
  { day: 0, label: "周日" },
];

function weeklyPeriods(setting: DefaultAttendancePeriod): [boolean, boolean][] {
  return (
    setting.weeklyPeriods ??
    Array.from({ length: 7 }, () => [...setting.periods])
  );
}

function describePeriods(setting: DefaultAttendancePeriod) {
  const days = weeklyPeriods(setting);
  if (days.every(([morning, afternoon]) => morning && afternoon))
    return "每天全天";
  if (days.every(([morning, afternoon]) => morning && !afternoon))
    return "每天上午";
  if (days.every(([morning, afternoon]) => !morning && afternoon))
    return "每天下午";
  return weekdays
    .flatMap(({ day, label }) => {
      const [morning, afternoon] = days[day];
      if (!morning && !afternoon) return [];
      return [
        `${label}${morning && afternoon ? "全天" : morning ? "上午" : "下午"}`,
      ];
    })
    .join("、");
}

export function DefaultAttendanceEditor({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { config, range, busy, run, saveConfig, notify, confirm } = useApp();
  const blank = (): DefaultAttendancePeriod => ({
    id: crypto.randomUUID(),
    personIds: [],
    range: { ...range },
    periods: [true, true],
    weeklyPeriods: Array.from({ length: 7 }, () => [false, false]),
    note: "",
  });
  const [draft, setDraft] = useState(blank);
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("");
  const [error, setError] = useState("");
  const settings = config.defaultAttendancePeriods;
  const selectedPeriods = weeklyPeriods(draft);
  const editing = settings.some((setting) => setting.id === draft.id);
  const visiblePeople = config.people.filter(
    (person) =>
      (!department || person.departmentId === department) &&
      `${person.fullName} ${person.deviceUserId}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const selectedPeople = config.people.filter((p) =>
    draft.personIds.includes(p.id),
  );

  async function save() {
    if (
      !selectedPeople.length ||
      !selectedPeriods.some((periods) => periods.some(Boolean))
    ) {
      setError("请至少选择一位人员和一个时段。");
      return;
    }
    if (
      !draft.range.startDate ||
      !draft.range.endDate ||
      draft.range.endDate < draft.range.startDate
    ) {
      setError("请选择有效的日期范围，结束日期不能早于开始日期。");
      return;
    }
    const days =
      (Date.parse(draft.range.endDate) - Date.parse(draft.range.startDate)) /
      86400000;
    if (days > 366) {
      setError("单条设置最多覆盖 367 天，请分段设置。");
      return;
    }
    const firstDate = new Date(`${draft.range.startDate}T00:00:00Z`);
    if (
      !Array.from({ length: days + 1 }, (_, offset) =>
        selectedPeriods[(firstDate.getUTCDay() + offset) % 7].some(Boolean),
      ).some(Boolean)
    ) {
      setError("日期范围内没有选中的星期时段，请调整日期或时段。");
      return;
    }
    setError("");
    await run("正在保存默认出勤…", async () => {
      const setting = {
        ...draft,
        weeklyPeriods: selectedPeriods,
        personIds: selectedPeople.map((p) => p.id),
      };
      await saveConfig({
        ...config,
        defaultAttendancePeriods: editing
          ? settings.map((item) => (item.id === draft.id ? setting : item))
          : [...settings, setting],
      });
      setDraft(blank());
      await onChanged();
      notify("默认出勤已保存，统计已重新计算。");
    });
  }

  function remove(setting: DefaultAttendancePeriod) {
    confirm(
      "删除默认出勤设置",
      `将撤销 ${setting.range.startDate} 至 ${setting.range.endDate} 的「${describePeriods(setting)}」默认出勤设置，并重新计算统计。`,
      async () => {
        await saveConfig({
          ...config,
          defaultAttendancePeriods: settings.filter(
            (item) => item.id !== setting.id,
          ),
        });
        if (draft.id === setting.id) setDraft(blank());
        await onChanged();
        notify("默认出勤设置已删除，统计已重新计算。");
      },
    );
  }

  return (
    <Modal
      title="默认出勤设置"
      subtitle="无法打卡的时段，可按班次计划计入出勤与工时"
      wide
      onClose={() => !busy && onClose()}
    >
      <div className="info-note">
        <Info size={16} />
        每个选中时段计半天出勤，按班次中保存的起止时间计算工时，即使该时段未启用也会计入。不计迟到、早退；人工免考勤优先，重叠设置不会重复累计。人员需先分配班次。
      </div>
      <form
        className="default-attendance-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={!!busy}>
          <h3>{editing ? "编辑设置" : "新增设置"}</h3>
          <div className="form-grid">
            <Field label="默认出勤开始日期">
              <input
                type="date"
                required
                min="1970-01-01"
                max="2200-12-31"
                value={draft.range.startDate}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    range: { ...draft.range, startDate: e.target.value },
                  })
                }
              />
            </Field>
            <Field label="默认出勤结束日期">
              <input
                type="date"
                required
                min={draft.range.startDate || "1970-01-01"}
                max="2200-12-31"
                value={draft.range.endDate}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    range: { ...draft.range, endDate: e.target.value },
                  })
                }
              />
            </Field>
          </div>
          <fieldset className="default-attendance-periods">
            <legend>按星期选择出勤时段</legend>
            <div className="default-attendance-week-actions">
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  setDraft({
                    ...draft,
                    weeklyPeriods: Array.from({ length: 7 }, () => [
                      true,
                      true,
                    ]),
                  })
                }
              >
                每天全天
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  setDraft({
                    ...draft,
                    weeklyPeriods: Array.from({ length: 7 }, (_, day) => [
                      day >= 1 && day <= 5,
                      day >= 1 && day <= 5,
                    ]),
                  })
                }
              >
                工作日全天
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  setDraft({
                    ...draft,
                    weeklyPeriods: Array.from({ length: 7 }, () => [
                      false,
                      false,
                    ]),
                  })
                }
              >
                清空时段
              </button>
            </div>
            <table
              className="default-attendance-week"
              aria-label="每周默认出勤时段"
            >
              <thead>
                <tr>
                  <th scope="col">星期</th>
                  <th scope="col">上午</th>
                  <th scope="col">下午</th>
                </tr>
              </thead>
              <tbody>
                {weekdays.map(({ day, label }) => (
                  <tr key={day}>
                    <th scope="row">{label}</th>
                    {[0, 1].map((half) => (
                      <td key={half}>
                        <input
                          type="checkbox"
                          aria-label={`${label}${half === 0 ? "上午" : "下午"}`}
                          checked={selectedPeriods[day][half]}
                          onChange={(e) => {
                            const updated: [boolean, boolean][] =
                              selectedPeriods.map((periods) => [...periods]);
                            updated[day][half] = e.target.checked;
                            setDraft({ ...draft, weeklyPeriods: updated });
                          }}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="subtle">
              仅在所选日期范围内生效，例如只选周三上午、周四下午。只设置某一天时，将开始和结束日期设为同一天。
            </p>
          </fieldset>
          <fieldset className="default-attendance-people">
            <legend>适用人员 · 已选 {selectedPeople.length} 人</legend>
            <div className="default-attendance-filters">
              <input
                aria-label="搜索默认出勤人员"
                placeholder="搜索姓名或设备 ID"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select
                aria-label="筛选默认出勤部门"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
              >
                <option value="">全部部门</option>
                {config.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="text-button"
                disabled={!visiblePeople.length}
                onClick={() =>
                  setDraft({
                    ...draft,
                    personIds: [
                      ...new Set([
                        ...draft.personIds,
                        ...visiblePeople.map((p) => p.id),
                      ]),
                    ],
                  })
                }
              >
                全选筛选结果
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => setDraft({ ...draft, personIds: [] })}
              >
                清空选择
              </button>
            </div>
            <div className="default-attendance-person-list">
              {visiblePeople.map((person) => (
                <label className="checkbox-label" key={person.id}>
                  <input
                    type="checkbox"
                    aria-label={`选择${person.fullName}（${person.deviceUserId}）`}
                    checked={draft.personIds.includes(person.id)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        personIds: e.target.checked
                          ? [...draft.personIds, person.id]
                          : draft.personIds.filter((id) => id !== person.id),
                      })
                    }
                  />
                  <span>
                    {person.fullName}{" "}
                    <small>
                      {person.deviceUserId}
                      {!person.shiftId && " · 未分配班次"}
                    </small>
                  </span>
                </label>
              ))}
              {!visiblePeople.length && (
                <p className="muted">
                  没有符合条件的人员，请先添加人员或调整筛选。
                </p>
              )}
            </div>
            <p className="subtle">
              选择按具体人员保存，后续新增人员不会自动加入。
            </p>
          </fieldset>
          <Field label="默认出勤原因（选填）">
            <textarea
              rows={2}
              maxLength={1000}
              placeholder="例如：设备故障、外出培训、统一活动…"
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
          </Field>
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          <div className="modal-actions">
            {editing && (
              <button
                type="button"
                className="button"
                onClick={() => {
                  setDraft(blank());
                  setError("");
                }}
              >
                取消编辑
              </button>
            )}
            <button className="button primary" type="submit">
              <Check size={16} />
              {editing ? "保存修改" : "保存默认出勤"}
            </button>
          </div>
        </fieldset>
      </form>
      <section
        className="default-attendance-settings"
        aria-label="已保存的默认出勤设置"
      >
        <h3>已保存设置 · {settings.length} 条</h3>
        {!settings.length && <p className="muted">尚未设置默认出勤。</p>}
        {settings.map((setting) => {
          const names = setting.personIds
            .map(
              (id) =>
                config.people.find((p) => p.id === id)?.fullName ??
                "已删除人员",
            )
            .join("、");
          return (
            <article className="default-attendance-setting" key={setting.id}>
              <div>
                <strong>
                  {setting.range.startDate} 至 {setting.range.endDate} ·{" "}
                  {describePeriods(setting)}
                </strong>
                <p>{names}</p>
                {setting.note && <p className="muted">{setting.note}</p>}
              </div>
              <div className="toolbar-actions">
                <button
                  type="button"
                  className="icon-button"
                  disabled={!!busy}
                  aria-label={`编辑默认出勤${setting.range.startDate}至${setting.range.endDate}：${names}`}
                  onClick={() => {
                    setDraft(structuredClone(setting));
                    setError("");
                  }}
                >
                  <PencilLine size={16} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  disabled={!!busy}
                  aria-label={`删除默认出勤${setting.range.startDate}至${setting.range.endDate}：${names}`}
                  onClick={() => remove(setting)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </article>
          );
        })}
      </section>
      <div className="modal-actions">
        <button
          type="button"
          className="button"
          disabled={!!busy}
          onClick={onClose}
        >
          完成
        </button>
      </div>
    </Modal>
  );
}
