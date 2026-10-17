import { call } from "./api";
import type { Bootstrap } from "./types";

let initialRequest: Promise<Bootstrap> | undefined;

export function loadInitialBootstrap() {
  // Begin reading data alongside the UI download, and reuse it on React mount.
  return (initialRequest ??= call<Bootstrap>("bootstrap"));
}
