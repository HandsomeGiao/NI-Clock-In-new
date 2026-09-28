import { createContext, useContext } from "react";
import type {
  AppConfig,
  Bootstrap,
  DateRange,
  DeviceStatus,
  Page,
  Progress,
} from "./types";
export interface AppContextValue {
  boot: Bootstrap;
  config: AppConfig;
  busy: string | null;
  dataVersion: number;
  range: DateRange;
  setRange: (range: DateRange) => void;
  device: DeviceStatus;
  setDevice: (device: DeviceStatus) => void;
  progress: Progress | null;
  navigate: (page: Page) => void;
  refresh: (useSavedRange?: boolean) => Promise<void>;
  saveConfig: (config: AppConfig) => Promise<AppConfig>;
  run: <T>(
    label: string,
    action: () => Promise<T>,
    success?: string,
  ) => Promise<T | undefined>;
  notify: (message: string, error?: boolean) => void;
  confirm: (
    title: string,
    description: string,
    action: () => Promise<void>,
  ) => void;
}
export const AppContext = createContext<AppContextValue | null>(null);
export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error("AppContext missing");
  return context;
}
