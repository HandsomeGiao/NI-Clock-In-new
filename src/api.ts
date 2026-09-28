import { invoke, isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
export async function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri())
    throw new Error(
      "请使用 npm run desktop 启动桌面应用。浏览器预览无法访问本地考勤数据和设备。",
    );
  return invoke<T>(command, args);
}
export async function chooseFile(
  name: string,
  extensions: string[],
  multiple = false,
) {
  return open({ title: name, filters: [{ name, extensions }], multiple });
}
export async function chooseDirectory() {
  return open({
    title: "选择旧版项目或 data 目录",
    directory: true,
    multiple: false,
  });
}
export async function saveFile(name: string, extension: string) {
  return save({
    defaultPath: name,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  });
}
export const localDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export const number = (n: number) =>
  n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
export function weekName(date: string) {
  const d = new Date(`${date}T12:00:00`),
    first = new Date(d.getFullYear(), d.getMonth(), 1);
  const firstMonday = new Date(first);
  firstMonday.setDate(1 + ((8 - first.getDay()) % 7));
  const week = Math.max(
    1,
    Math.floor((d.getTime() - firstMonday.getTime()) / 604800000) + 1,
  );
  return `${d.getFullYear()}年${d.getMonth() + 1}月第${week}周.xlsx`;
}
export function newShift(): import("./types").Shift {
  return {
    id: crypto.randomUUID(),
    name: "新班次",
    days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek,
      morningEnabled: dayOfWeek > 0 && dayOfWeek < 6,
      morningStart: "09:00",
      morningEnd: "12:00",
      afternoonEnabled: dayOfWeek > 0 && dayOfWeek < 6,
      afternoonStart: "14:00",
      afternoonEnd: "17:30",
    })),
  };
}
