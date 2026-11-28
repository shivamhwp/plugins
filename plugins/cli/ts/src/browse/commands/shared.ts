export { pyError, pyIntArg } from "../pyerror.ts";
import type { Element, Page } from "../state/page.ts";
import { activeTarget, type State, targetScope } from "../state/state.ts";
import { newTab } from "./core.ts";
import { borrowedTab } from "./borrowed.ts";
export { borrowedTab, refuseOnBorrowed } from "./borrowed.ts";
import type { Ctx } from "./ctx.ts";

export function noteOwnTab(state: State, page: Page, borrowed: string): void {
  state.addNotice(
    `→ Opened in its own background tab [${state.tabId(page.targetId)}], since this session uses your tab ` +
      `[${state.tabId(borrowed)}] and won't navigate it; \`tab ${state.tabId(borrowed)}\` goes back`,
  );
}

export async function currentOrNew(ctx: Ctx): Promise<Page> {
  const state = ctx.state;
  await state.connect();
  const scoped = targetScope.getStore() ?? null;
  if (scoped !== null) return state.page(scoped);
  const borrowed = borrowedTab(state);
  const target = activeTarget(state);
  if (target && state.targetInfos.has(target) && !borrowed) return state.page();
  const page = await newTab(ctx, null);
  if (borrowed) noteOwnTab(state, page, borrowed);
  return page;
}

export const APPEAR_WAIT = 3.0;
export const CHECKS_PRESENCE = new Set(["is"]);

export async function resolve(ctx: Ctx, selector: string): Promise<[Page, Element]> {
  return ctx.state.locate(selector, null, CHECKS_PRESENCE.has(ctx.command) ? 0 : APPEAR_WAIT);
}

export function frameOrMain(ctx: Ctx, page: Page): string {
  return (ctx.state.frameFor(page) || page.mainFrame) as string;
}

export function originOf(page: Page, frame: string | null): string {
  return (frame === null ? undefined : page.frames.get(frame)?.origin) || "";
}
