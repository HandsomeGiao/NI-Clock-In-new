// The static splash stays outside React so it is visible before the app loads.
let recoveryTimer: ReturnType<typeof setTimeout> | undefined;

export function setStartupMessage(message: string) {
  const screen = document.getElementById("startup-screen");
  const status = document.getElementById("startup-message");
  if (status && !screen?.classList.contains("has-error"))
    status.textContent = message;
}

export function initializeStartup() {
  recoveryTimer = setTimeout(() => {
    document.getElementById("startup-recovery")?.removeAttribute("hidden");
  }, 12_000);
}

export function showStartupError(error: unknown) {
  clearTimeout(recoveryTimer);
  const screen = document.getElementById("startup-screen");
  const status = document.getElementById("startup-message");
  const hint = document.getElementById("startup-hint");
  screen?.classList.add("has-error");
  if (status) {
    status.setAttribute("role", "alert");
    status.setAttribute("aria-live", "assertive");
    status.textContent = error instanceof Error ? error.message : String(error);
  }
  if (hint) hint.textContent = "工作台未能打开，请尝试重新加载。";
  document.getElementById("startup-recovery")?.removeAttribute("hidden");
}

export function dismissStartup() {
  clearTimeout(recoveryTimer);
  document.getElementById("root")?.removeAttribute("inert");
  const screen = document.getElementById("startup-screen");
  if (!screen || screen.classList.contains("is-leaving")) return;
  screen.classList.add("is-leaving");
  screen.setAttribute("aria-hidden", "true");
  screen.setAttribute("inert", "");
  // Only fade over an already committed app; never impose a minimum load time.
  setTimeout(() => screen.remove(), 180);
}
