import { useEffect, useId, useRef, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Inbox,
  LoaderCircle,
  X,
} from "lucide-react";
import { localDate } from "./api";
import type { DateRange } from "./types";

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    titleId = useId();
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`modal ${wide ? "wide" : ""}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-heading">
        <div>
          <h2 id={titleId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Inbox size={30} strokeWidth={1.4} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={22} />
      <span>正在读取本地数据…</span>
    </div>
  );
}
export function Pagination({
  page,
  total,
  size,
  setPage,
}: {
  page: number;
  total: number;
  size: number;
  setPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div className="pagination">
      <span>
        共 <strong>{total}</strong> 条 ·{" "}
        {total
          ? `${page * size + 1}–${Math.min((page + 1) * size, total)}`
          : "0"}
      </span>
      <div>
        <button
          className="icon-button"
          disabled={page === 0}
          aria-label="上一页"
          onClick={() => setPage(page - 1)}
        >
          <ChevronLeft size={17} />
        </button>
        <span>
          {page + 1} / {pages}
        </span>
        <button
          className="icon-button"
          disabled={page + 1 >= pages}
          aria-label="下一页"
          onClick={() => setPage(page + 1)}
        >
          <ChevronRight size={17} />
        </button>
      </div>
    </div>
  );
}
export function RangePicker({
  range,
  onChange,
}: {
  range: DateRange;
  onChange: (range: DateRange) => void;
}) {
  function preset(type: string) {
    const end = new Date(),
      start = new Date();
    if (type === "today") {
      /* same day */
    }
    if (type === "week" || type === "lastWeek") {
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      if (type === "lastWeek") {
        start.setDate(start.getDate() - 7);
        end.setTime(start.getTime());
        end.setDate(end.getDate() + 6);
      }
    }
    if (type === "month") start.setDate(1);
    onChange({ startDate: localDate(start), endDate: localDate(end) });
  }
  return (
    <div className="range-picker">
      <select
        aria-label="快捷日期"
        value=""
        onChange={(e) => preset(e.target.value)}
      >
        <option value="" disabled>
          快捷日期
        </option>
        <option value="today">今天</option>
        <option value="week">本周</option>
        <option value="lastWeek">上周</option>
        <option value="month">本月</option>
      </select>
      <input
        type="date"
        aria-label="开始日期"
        min="1970-01-01"
        max="2200-12-31"
        value={range.startDate}
        onChange={(e) => onChange({ ...range, startDate: e.target.value })}
      />
      <span>至</span>
      <input
        type="date"
        aria-label="结束日期"
        min={range.startDate}
        max="2200-12-31"
        value={range.endDate}
        onChange={(e) => onChange({ ...range, endDate: e.target.value })}
      />
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "green" | "amber" | "red" | "neutral" | "blue";
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
