import { loadInitialBootstrap } from "./bootstrap";
import {
  initializeStartup,
  setStartupMessage,
  showStartupError,
} from "./startup";

initializeStartup();
setStartupMessage("正在读取本地数据…");
void loadInitialBootstrap().then(
  () => setStartupMessage("正在准备工作台…"),
  showStartupError,
);
void import("./main").catch(showStartupError);
