export interface DateRange {
  startDate: string;
  endDate: string;
}
export interface ConnectionSettings {
  ipAddress: string;
  port: number;
  commKey: number;
  machineNumber: number;
}
export interface TimeWindow {
  start: string;
  end: string;
}
export interface Rules {
  lateEarlyThresholdMinutes: number;
  debugDetailsEnabled: boolean;
  windows: TimeWindow[];
}
export interface Department {
  id: string;
  name: string;
  isSystem: boolean;
}
export interface Person {
  id: string;
  deviceUserId: string;
  fullName: string;
  grade: string;
  departmentId: string;
  shiftId: string | null;
}
export interface ShiftDay {
  dayOfWeek: number;
  morningEnabled: boolean;
  morningStart: string;
  morningEnd: string;
  afternoonEnabled: boolean;
  afternoonStart: string;
  afternoonEnd: string;
}
export interface Shift {
  id: string;
  name: string;
  days: ShiftDay[];
}
export interface AppConfig {
  revision: number;
  connection: ConnectionSettings;
  rules: Rules;
  departments: Department[];
  people: Person[];
  shifts: Shift[];
  query: DateRange;
}
export interface Bootstrap {
  config: AppConfig;
  logCount: number;
  reviewCount: number;
  dataDirectory: string;
  legacyPath: string | null;
  coverage: DateRange[];
}
export interface DeviceStatus {
  connected: boolean;
  sdkAvailable: boolean;
  recordCount: number | null;
  sdkSource: string;
  error: string | null;
}
export interface Progress {
  loaded: number;
  total: number | null;
  message: string;
}
export interface ImportSummary {
  added: number;
  updated: number;
  skipped: number;
  warnings: string[];
}
export interface LogRecord {
  id: number;
  userId: string;
  timestamp: string;
  verifyMode: number;
  inOutMode: number;
  workCode: number;
  personName: string;
  departmentName: string;
}
export interface LogQuery {
  range: DateRange;
  search: string;
  departmentIds: string[];
  page: number;
  pageSize: number;
}
export interface LogPage {
  records: LogRecord[];
  total: number;
}
export interface Statistic {
  deviceUserId: string;
  personName: string;
  departmentName: string;
  grade: string;
  expectedDays: number;
  actualDays: number;
  lateCount: number;
  earlyLeaveCount: number;
  absentDays: number;
  attendanceHours: number;
}
export interface Review {
  deviceUserId: string;
  date: string;
  punches: (string | null)[];
  exempt: boolean[];
  note: string;
}
export interface Detail extends Review {
  personName: string;
  departmentName: string;
  scheduled: (string | null)[];
  late: boolean[];
  early: boolean[];
  absent: boolean[];
  hours: number;
  reviewed: boolean;
}
export interface StatisticsResult {
  rows: Statistic[];
  details: Detail[];
  warnings: string[];
  range: DateRange;
}
export type Page =
  "statistics" | "logs" | "people" | "shifts" | "device" | "settings";
