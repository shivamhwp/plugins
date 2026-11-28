import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import "./libc-loaded.ts";
import "../src/browse/commands/all.ts";
import { replArgv } from "../src/browse/route.ts";
import { placeEndpointFlags } from "../src/endpoint-flags.ts";
import { scriptSource } from "../src/browse/local.ts";
import { printGuide } from "../src/skills.ts";
import { checkCommand } from "../src/skill-examples.ts";
import { dropRepl, Runner, takeRunner, whenReady } from "../src/browse/script/host.ts";
import { render, Result } from "../src/browse/daemon/render.ts";
import { Ctx } from "../src/browse/commands/ctx.ts";
import { cmdOpen } from "../src/browse/commands/core.ts";
import { cmdGet, cmdVitals } from "../src/browse/commands/read.ts";
import { cmdHistory, cmdReload } from "../src/browse/commands/nav.ts";
import { takeOut } from "../src/browse/outfile.ts";
import { cmdReadUrls } from "../src/browse/commands/read-urls.ts";
import { dispatch } from "../src/browse/commands/index.ts";
import { withSignal } from "../src/browse/cdp/cancel.ts";
import { readFileSync } from "node:fs";
import { closeTab } from "../src/browse/commands/tabs.ts";
import { refuseOnBorrowed } from "../src/browse/commands/borrowed.ts";
import { hasPendingReaction, settleReaction, watchReaction } from "../src/browse/changes/observe.ts";
import { pageForSelector } from "../src/browse/changes/dialogs.ts";
import { COUNTS as DAEMON_COUNTS, FLAGS as DAEMON_FLAGS } from "../src/browse/metrics.ts";
import { isMetricCount, isMetricFlag } from "../src/command-metrics.ts";
import { cmdScript, MOVED, RunSemaphore, ScriptRun } from "../src/browse/script/script.ts";
import { Page } from "../src/browse/state/page.ts";
import { activeTarget, State, withTarget } from "../src/browse/state/state.ts";
import { BrowseError } from "../src/browse/daemon-errors.ts";

async function runMock(source: string, handler: (request: Record<string, unknown>) => Record<string, unknown>, repl = true) {
  const { runner } = takeRunner();
  const requests: Record<string, unknown>[] = [];
  try {
    expect(await whenReady(runner)).toBeGreaterThanOrEqual(0);
    runner.send({ type: "start", source, state: "{}", readBatch: 100, stateLimit: 1024 * 1024, ...(repl ? { repl: true, spill: 0 } : {}) });
    for (;;) {
      const event = await runner.next();
      if (event.type === "request") {
        const request = JSON.parse(event.request) as Record<string, unknown>;
        requests.push(request);
        runner.send({ type: "reply", id: request["id"] as number, answer: JSON.stringify(handler(request)) });
      } else if (event.type === "done") {
        return { requests, result: JSON.parse(event.result) as Record<string, unknown> };
      } else if (event.type === "exit") {
        throw new Error(`runner exited early: ${String(event.code ?? event.signal)}`);
      }
    }
  } finally {
    runner.kill();
  }
}

describe("top-level repl and guide routing", () => {
  test("replArgv hoists shared flags and forwards --timeout to script", () => {
    expect(replArgv(["repl", "return 1"])).toEqual({ hoisted: [], rest: ["return 1"] });
    expect(replArgv(["--port", "9444", "--json", "repl", "--close", "return 1"])).toEqual({
      hoisted: ["--port", "9444", "--json"],
      rest: ["--close", "return 1"],
    });
    expect(replArgv(["--timeout", "3m", "repl", "-e", "return 1"])).toEqual({
      hoisted: [],
      rest: ["--timeout", "3m", "-e", "return 1"],
    });
    expect(replArgv(["browse", "open", "https://example.com"])).toBeUndefined();
  });

  test("placeEndpointFlags keeps --port and moves --session after repl", () => {
    expect(placeEndpointFlags(["--session", "demo", "--port", "9444", "repl", "return 1"])).toEqual({
      argv: ["--port", "9444", "repl", "--session", "demo", "return 1"],
      dropped: [],
    });
  });

  test("scriptSource supports -e, -f, --close, and inline code", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ardia-repl-src-"));
    try {
      const file = path.join(dir, "job.js");
      writeFileSync(file, "return 42;");
      expect(scriptSource(["-e", "return 1 + 1", "--close"], dir, (p) => p)).toBe("return 1 + 1");
      expect(scriptSource(["-c", "return 2 + 2", "--ephemeral"], dir, (p) => p)).toBe("return 2 + 2");
      expect(scriptSource(["-f", file, "--cleanup"], dir, (p) => p)).toBe("return 42;");
      expect(scriptSource(["--reset"], dir, (p) => p)).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("printGuide serves SKILL.md, repl reference, and lists topics on unknown name", () => {
    const overview = printGuide(undefined);
    expect(overview.status).toBe(0);
    expect(overview.raw).toContain("ardia repl");
    const replDoc = printGuide("repl");
    expect(replDoc.status).toBe(0);
    expect(replDoc.raw).toContain("withTabs");
    expect(printGuide("script").raw).toBe(replDoc.raw);
    const bad = printGuide("nonexistent-topic");
    expect(bad.status).toBe(1);
    expect(bad.out[0]).toContain("Available topics:");
  });

  test("skill example checker validates ardia repl and ardia guide", () => {
    expect(checkCommand("ardia repl --close -e 'return 1'")).toEqual([]);
    expect(checkCommand("ardia repl -f task.js --timeout 3m")).toEqual([]);
    expect(checkCommand("ardia guide repl")).toEqual([]);
    expect(checkCommand("ardia repl --bogus-flag")[0]).toContain("doesn't take --bogus-flag");
  });

  test("compact_boundaries renders compact page-data fence", () => {
    const [, out] = render({ content_boundaries: true, compact_boundaries: true }, new Result({ value: 4 }, "4", true), null, "script");
    expect(out).toMatch(/^<page-data nonce="[0-9a-f]{16}">\n4\n<\/page-data>\n$/);
  });
});

describe("target-bound Page handles, multi-tab helpers, fast allTexts and snapshot diffing", () => {
  test("openTabs and withTabs bind requests to distinct targets and close on exit", async () => {
    let nextTarget = 1;
    const { requests, result } = await runMock(
      `
        const out = await withTabs(['https://a.test', 'https://b.test'], async ([a, b]) => {
          const [ta, tb] = await Promise.all([a.title(), b.title()]);
          const textsA = await a.locator('li').allTexts();
          return { ua: a.url(), ub: b.url(), ta, tb, textsA, liveCount: tabs.length };
        });
        return { out, afterCount: tabs.length };
      `,
      (request) => {
        const argv = (request["argv"] as string[]) ?? [];
        if (argv[0] === "tab" && argv[1] === "new") {
          const n = nextTarget++;
          return { ok: true, text: argv[2] ?? "", data: { tabId: `t${n}`, targetId: `T${n}`, url: argv[2] ?? "", owned: true } };
        }
        if (argv[0] === "tab" && argv[1] === "close") {
          return { ok: true, text: "closed", data: { closed: argv[2] } };
        }
        if (argv[0] === "get" && argv[1] === "title") {
          return { ok: true, text: `Title ${request["target"]}`, data: { title: `Title ${request["target"]}` } };
        }
        if (argv[0] === "get" && argv[1] === "texts") {
          return { ok: true, text: "one\ntwo", data: { texts: ["one", "two"] } };
        }
        return { ok: true, text: "ok", data: {} };
      },
    );
    expect(result["kind"]).toBe("done");
    expect(result["value"]).toEqual({
      out: { ua: "https://a.test", ub: "https://b.test", ta: "Title T1", tb: "Title T2", textsA: ["one", "two"], liveCount: 2 },
      afterCount: 0,
    });
    const opens = requests.filter((r) => Array.isArray(r["argv"]) && r["argv"][0] === "tab" && r["argv"][1] === "new");
    expect(opens.every((r) => r["parallelTab"] === true)).toBe(true);
    const closes = requests.filter((r) => Array.isArray(r["argv"]) && r["argv"][0] === "tab" && r["argv"][1] === "close");
    expect(closes).toHaveLength(2);
    expect(closes.every((r) => r["detachBorrowed"] === true)).toBe(true);
  });

  test("withTab closes the tab even when callback throws", async () => {
    const { requests, result } = await runMock(
      `
        let caught = null;
        try {
          await withTab('https://err.test', async () => { throw new Error('boom'); });
        } catch (err) {
          caught = err.message;
        }
        return { caught, remaining: tabs.length };
      `,
      (request) => {
        const argv = (request["argv"] as string[]) ?? [];
        if (argv[0] === "tab" && argv[1] === "new") return { ok: true, text: "", data: { tabId: "t1", targetId: "T1", url: "https://err.test", owned: true } };
        if (argv[0] === "tab" && argv[1] === "close") return { ok: true, text: "", data: { closed: "T1" } };
        return { ok: true, text: "", data: {} };
      },
    );
    expect(result["value"]).toEqual({ caught: "boom", remaining: 0 });
    expect(requests.some((r) => Array.isArray(r["argv"]) && r["argv"][0] === "tab" && r["argv"][1] === "close" && r["argv"][2] === "T1")).toBe(true);
  });

  test("snapshot auto-diffs across calls and serializes compact text", async () => {
    const trees = [
      "heading 'Home'\nbutton 'One' [@e1]\nbutton 'Two' [@e2]\nbutton 'Three' [@e3]\nbutton 'Four' [@e4]\nbutton 'Five' [@e5]",
      "heading 'Home'\nbutton 'One' [@e1]\nbutton 'Two' [@e2]\nbutton 'Three' [@e3]\nbutton 'Four' [@e4]\nbutton 'Five' [@e5]",
      "heading 'Home'\nbutton 'One' [@e1]\nbutton 'Two' [@e2]\nbutton 'Three' [@e3]\nbutton 'Four' [@e4]\nbutton 'Six' [@e6]",
    ];
    let step = 0;
    const { result } = await runMock(
      `
        const p = await openTab('https://snap.test');
        const s1 = await snapshot(p, { interactive: true });
        const s2 = await snapshot(p, { interactive: true });
        const s3 = await snapshot(p, { interactive: true });
        const s4 = await snapshot(p, { interactive: true, diff: false });
        return {
          d1: s1.diff,
          d2: s2.diff,
          d3: s3.diff,
          d4: s4.diff,
          serialized: JSON.parse(JSON.stringify(s3)),
        };
      `,
      (request) => {
        const argv = (request["argv"] as string[]) ?? [];
        if (argv[0] === "tab" && argv[1] === "new") return { ok: true, text: "", data: { tabId: "t1", targetId: "T1", url: "https://snap.test", owned: true } };
        if (argv[0] === "snapshot") return { ok: true, text: trees[Math.min(step++, trees.length - 1)], data: {} };
        return { ok: true, text: "", data: {} };
      },
    );
    const value = result["value"] as Record<string, unknown>;
    expect(value["d1"]).toBeNull();
    expect(value["d2"]).toBe("(no changes)");
    expect(value["d3"]).toBe("- button 'Five' [@e5]\n+ button 'Six' [@e6]");
    expect(value["d4"]).toBeNull();
    expect(value["serialized"]).toBe("- button 'Five' [@e5]\n+ button 'Six' [@e6]");
  });

  test("selectOption unwraps Playwright option objects, getByRole matches labels, refs normalize, and readUrls falls back when no tab is open", async () => {
    const { requests, result } = await runMock(
      `
        await page.selectOption('#start', { label: '2:00 PM' });
        await page.locator('[ref=e12]').click();
        const roleSel = page.getByRole('textbox', { name: /Annual total/ }).selector;
        const pages = await readUrls(['https://docs.test/a']);
        return { roleSel, pages };
      `,
      (request) => {
        const argv = (request["argv"] as string[]) ?? [];
        if (argv[0] === "read-urls") return { ok: false, error: "The user isn't on a web page right now", code: "not_web_page" };
        if (argv[0] === "read") return { ok: true, text: "doc", data: { pages: [{ url: "https://docs.test/a", text: "ok" }] } };
        return { ok: true, text: "ok", data: {} };
      },
    );
    expect(result["kind"]).toBe("done");
    const value = result["value"] as Record<string, unknown>;
    expect(String(value["roleSel"])).toContain("//label[");
    expect(String(value["roleSel"])).toContain("ancestor::label[");
    expect(value["pages"]).toEqual([
      { url: "https://docs.test/a", finalUrl: "https://docs.test/a", ok: true, title: "", content: "ok", text: "ok", chars: 2, truncated: false, error: null },
    ]);
    const argvs = requests.map((r) => r["argv"]);
    expect(argvs).toContainEqual(["select", "#start", "2:00 PM"]);
    expect(argvs).toContainEqual(["click", "@e12"]);
  });

  test("const tabs persists across REPL calls, withTabs cleans partial opens, attachTab enforces exact/unambiguous matching, and selectOption({index}) resolves by index", async () => {
    const runner = new Runner();
    try {
      expect(await whenReady(runner)).toBeGreaterThanOrEqual(0);
      const runTurn = async (source: string, handler: (request: Record<string, unknown>) => Record<string, unknown>) => {
        const requests: Record<string, unknown>[] = [];
        runner.send({ type: "start", source, state: "{}", readBatch: 100, stateLimit: 1024 * 1024, repl: true, spill: 0 });
        for (;;) {
          const event = await runner.next();
          if (event.type === "request") {
            const request = JSON.parse(event.request) as Record<string, unknown>;
            requests.push(request);
            runner.send({ type: "reply", id: request["id"] as number, answer: JSON.stringify(handler(request)) });
          } else if (event.type === "done") {
            return { requests, result: JSON.parse(event.result) as Record<string, unknown> };
          }
        }
      };

      const t1 = await runTurn("const tabs = await listTabs(); return tabs.length;", () => ({
        ok: true,
        text: "",
        data: { tabs: [{ tabId: "t1", targetId: "T1", url: "https://a.test", title: "Alpha", openedBySession: true }] },
      }));
      expect(t1.result["value"]).toBe(1);
      const t2 = await runTurn("return [Array.isArray(tabs), tabs[0].tabId];", () => ({ ok: true, text: "", data: {} }));
      expect(t2.result["value"]).toEqual([true, "t1"]);

      const t3 = await runTurn(
        `
          let emptyErr = null, ambigErr = null, partialErr = null;
          try { await attachTab(""); } catch (e) { emptyErr = e.name; }
          try { await attachTab("shared"); } catch (e) { ambigErr = e.message; }
          const owned = await attachTab("t1");
          await page.selectOption("#pick", { index: 1 });
          try {
            await withTabs(["https://ok.test", "https://fail.test"], async () => "never");
          } catch (e) {
            partialErr = e.message;
          }
          const fallback = await readUrls(["https://docs.test/a"], { maxChars: 4 });
          return { emptyErr, ambigErr, ownedFlag: owned.owned, partialErr, fallback };
        `,
        (request) => {
          if (request["op"] === "$eval") return { ok: true, text: "", data: { result: "opt-b" } };
          const argv = (request["argv"] as string[]) ?? [];
          if (argv[0] === "tab" && argv[1] === "list") {
            return {
              ok: true,
              text: "",
              data: {
                tabs: [
                  { tabId: "t1", targetId: "T1", url: "https://shared.test/1", title: "One", openedBySession: true },
                  { tabId: "t2", targetId: "T2", url: "https://shared.test/2", title: "Two", openedBySession: false },
                ],
              },
            };
          }
          if (argv[0] === "tab" && argv[1] === "new") {
            if (argv[2] === "https://fail.test") return { ok: false, error: "navigation failed", code: "navigation_failed" };
            return { ok: true, text: "", data: { tabId: "t9", targetId: "T9", url: argv[2], openedBySession: true } };
          }
          if (argv[0] === "tab" && argv[1] === "close") return { ok: true, text: "", data: { closed: argv[2] } };
          if (argv[0] === "read-urls") return { ok: false, error: "isn't on a web page", code: "not_web_page" };
          if (argv[0] === "read") return { ok: true, text: "", data: { pages: [{ url: "https://docs.test/a", title: "Doc", text: "abcdef" }] } };
          return { ok: true, text: "ok", data: {} };
        },
      );
      const val = t3.result["value"] as Record<string, unknown>;
      expect(val["emptyErr"]).toBe("TypeError");
      expect(String(val["ambigErr"])).toContain("Multiple tabs matched");
      expect(val["ownedFlag"]).toBe(true);
      expect(val["partialErr"]).toBe("navigation failed");
      expect(val["fallback"]).toEqual([
        { url: "https://docs.test/a", finalUrl: "https://docs.test/a", ok: true, title: "Doc", content: "abcd", text: "abcd", chars: 6, truncated: true, error: null },
      ]);
      expect(t3.requests.some((r) => Array.isArray(r["argv"]) && r["argv"][0] === "select" && r["argv"][2] === "opt-b")).toBe(true);
      expect(t3.requests.some((r) => Array.isArray(r["argv"]) && r["argv"][0] === "tab" && r["argv"][1] === "close" && r["argv"][2] === "T9")).toBe(true);

      runner.send({ type: "closed", targets: ["T1"] });
      const t4 = await runTurn("return await getTabByTargetId('T1').then(() => 'reattached');", () => ({
        ok: true,
        text: "",
        data: { tabs: [{ tabId: "t1", targetId: "T1", url: "https://shared.test/1", title: "One", openedBySession: true }] },
      }));
      expect(t4.requests.some((r) => Array.isArray(r["argv"]) && r["argv"][0] === "tab" && r["argv"][1] === "list")).toBe(true);
      expect(t4.result["value"]).toBe("reattached");
    } finally {
      runner.kill();
    }
  });
});

describe("review fixes: borrowed-tab guards, receipts, relative goto, snapshots and repl --out", () => {
  test("a handle bound to a user tab the session didn't open can't navigate, reload, step history or run vitals on it", async () => {
    const { state } = serverTestState();
    const ctx = (command: string) => new Ctx(state, {}, process.cwd(), {}, null, command);
    await expect(withTarget("T_USER_BG", () => cmdOpen(ctx("open"), ["--here", "https://evil.test/"]))).rejects.toThrow("only runs outside a tab handle");
    await expect(withTarget("T_USER_BG", () => cmdReload(ctx("reload"), []))).rejects.toThrow("using your tab");
    await expect(withTarget("T_USER_BG", () => cmdHistory(ctx("back"), []))).rejects.toThrow("using your tab");
    await expect(withTarget("T_USER_BG", () => cmdVitals(ctx("vitals"), ["https://evil.test/"]))).rejects.toThrow("using your tab");
    await expect(withTarget("T_USER", () => cmdVitals(ctx("vitals"), ["https://evil.test/"]))).rejects.toThrow("using your tab");
  });

  test("repl --out is taken like script --out", () => {
    expect(takeOut(["repl", "-e", "return 1", "--out", "answer.json"], "repl")).toEqual([["repl", "-e", "return 1"], "answer.json"]);
    expect(takeOut(["script", "--out=answer.json"], "script")).toEqual([["script"], "answer.json"]);
  });

  test("an unbound action on the bound handle's tab clears that handle's receipt", async () => {
    const { result } = await runMock(
      `
        const p = await openTab('https://a.test');
        await p.act.click('#save');
        await page.fill('#note', 'gone');
        return await p.assertText('Saved').then(() => 'from stale receipt', () => 'read the page');
      `,
      (request) => {
        const argv = (request["argv"] as string[]) ?? [];
        const ranOn = { ranOn: (request["target"] as string | undefined) ?? "T1" };
        if (argv[0] === "tab" && argv[1] === "new") return { ok: true, text: "", data: { tabId: "t1", targetId: "T1", url: "https://a.test/", owned: true } };
        if (argv[0] === "click") return { ok: true, text: "✓ clicked\nchanges\n  Saved", data: { changes: { text: { lines: ["Saved"] } } }, ...ranOn };
        if (argv[0] === "get" && argv[1] === "text") return { ok: true, text: "nothing here", data: { text: "nothing here" }, ...ranOn };
        return { ok: true, text: "ok", data: {}, ...ranOn };
      },
    );
    expect(result["value"]).toBe("read the page");
  });

  test("relative goto resolves against the tab's live URL, sleeps are bound, act.select keeps the option object and asks for a receipt", async () => {
    const { requests, result } = await runMock(
      `
        const p = await openTab('https://a.test/start');
        await p.goto('/result');
        await p.waitForTimeout(1);
        await p.wait(1);
        const picked = await page.act.select('select', { label: 'Canada' });
        return { picked: typeof picked === 'object' && picked !== null && picked.ok === true };
      `,
      (request) => {
        const argv = (request["argv"] as string[]) ?? [];
        if (argv[0] === "tab" && argv[1] === "new") return { ok: true, text: "", data: { tabId: "t1", targetId: "T1", url: "https://a.test/start", owned: true } };
        if (argv[0] === "get" && argv[1] === "url") return { ok: true, text: "https://b.test/next", data: { url: "https://b.test/next" } };
        if (argv[0] === "open") return { ok: true, text: "", data: { url: argv[1] }, url: argv[1] };
        if (argv[0] === "select") return { ok: true, text: "✓ selected", data: {} };
        return { ok: true, text: "ok", data: {} };
      },
    );
    expect(requests.find((r) => Array.isArray(r["argv"]) && r["argv"][0] === "open")?.["argv"]).toEqual(["open", "--", "https://b.test/result"]);
    const sleeps = requests.filter((r) => r["op"] === "sleep");
    expect(sleeps).toHaveLength(2);
    expect(sleeps.every((r) => r["target"] === "T1")).toBe(true);
    const select = requests.find((r) => Array.isArray(r["argv"]) && r["argv"][0] === "select");
    expect(select?.["argv"]).toEqual(["select", "select", "Canada"]);
    expect(select?.["receipt"]).toBe(true);
    expect((result["value"] as Record<string, unknown>)["picked"]).toBe(true);
  });

  test("withTabs surfaces a failed close after its callback succeeds", async () => {
    let next = 1;
    const { result } = await runMock(
      `
        return await withTabs(['https://a.test', 'https://b.test'], async () => 'done').then((v) => v, (e) => 'failed: ' + e.message);
      `,
      (request) => {
        const argv = (request["argv"] as string[]) ?? [];
        if (argv[0] === "tab" && argv[1] === "new") {
          const n = next++;
          return { ok: true, text: "", data: { tabId: `t${n}`, targetId: `T${n}`, url: argv[2], owned: true } };
        }
        if (argv[0] === "tab" && argv[1] === "close") return argv[2] === "T2" ? { ok: false, error: "close refused", code: "failed" } : { ok: true, text: "", data: { closed: argv[2] } };
        return { ok: true, text: "ok", data: {} };
      },
    );
    expect(result["value"]).toBe("failed: close refused");
  });

  test("snapshots keep a baseline per real tab and never call a reordered large tree unchanged", async () => {
    let current = "T1";
    const big = Array.from({ length: 501 }, (_, i) => `row ${i}`);
    const swapped = [...big];
    [swapped[0], swapped[1]] = [swapped[1] as string, swapped[0] as string];
    const bigTrees = [big.join("\n"), swapped.join("\n")];
    let bigStep = 0;
    const { result } = await runMock(
      `
        const s1 = await snapshot();
        await useTab('t2');
        const s2 = await snapshot();
        const p = await openTab('https://big.test');
        await snapshot(p);
        const s4 = await snapshot(p);
        return { d1: s1.diff, d2: s2.diff, d4: s4.diff, full: s4.text === s4.tree };
      `,
      (request) => {
        const argv = (request["argv"] as string[]) ?? [];
        const target = request["target"] as string | undefined;
        if (argv[0] === "tab" && argv[1] === "new") return { ok: true, text: "", data: { tabId: "t9", targetId: "T9", url: "https://big.test/", owned: true } };
        if (argv[0] === "tab" && argv[1] === "t2") {
          current = "T2";
          return { ok: true, text: "", data: { tabId: "t2", targetId: "T2" }, ranOn: current };
        }
        if (argv[0] === "snapshot") {
          if (target === "T9") return { ok: true, text: bigTrees[Math.min(bigStep++, 1)], data: {}, ranOn: target };
          return { ok: true, text: "heading 'Same'", data: {}, ranOn: current };
        }
        return { ok: true, text: "ok", data: {}, ranOn: target ?? current };
      },
    );
    const value = result["value"] as Record<string, unknown>;
    expect(value["d1"]).toBeNull();
    expect(value["d2"]).toBeNull();
    expect(value["d4"]).toBeNull();
    expect(value["full"]).toBe(true);
  });
});

async function runOrdered(source: string, handler: (request: Record<string, unknown>) => Record<string, unknown>, holdUntil: (request: Record<string, unknown>) => string | null) {
  const { runner } = takeRunner();
  const held = new Map<string, Record<string, unknown>>();
  try {
    expect(await whenReady(runner)).toBeGreaterThanOrEqual(0);
    runner.send({ type: "start", source, state: "{}", readBatch: 100, stateLimit: 1024 * 1024, repl: true, spill: 0 });
    for (;;) {
      const event = await runner.next();
      if (event.type === "request") {
        const request = JSON.parse(event.request) as Record<string, unknown>;
        const key = holdUntil(request);
        const answer = (r: Record<string, unknown>) => runner.send({ type: "reply", id: r["id"] as number, answer: JSON.stringify(handler(r)) });
        if (key !== null && key.startsWith("hold:")) {
          held.set(key.slice(5), request);
          continue;
        }
        answer(request);
        if (key !== null && key.startsWith("release:") && held.has(key.slice(8))) answer(held.get(key.slice(8)) as Record<string, unknown>);
      } else if (event.type === "done") {
        return JSON.parse(event.result) as Record<string, unknown>;
      } else if (event.type === "exit") {
        throw new Error(`runner exited early: ${String(event.code ?? event.signal)}`);
      }
    }
  } finally {
    runner.kill();
  }
}

describe("second review round: borrowed goto, bound newTab click, late creates, repeat close, hold refusal, readUrls, diff order", () => {
  test("a bound open --show can't hand a borrowed off-screen tab to a new one, and goto passes its URL as a positional", async () => {
    const { state, closedTargets } = serverTestState();
    state.setOffscreen("T_USER_BG", true);
    state.setOffscreen("T_USER", true);
    const ctx = new Ctx(state, {}, process.cwd(), {}, null, "open");
    await expect(withTarget("T_USER_BG", () => cmdOpen(ctx, ["--show"]))).rejects.toThrow("using your tab");
    await expect(withTarget("T_USER", () => cmdOpen(ctx, ["--show"]))).rejects.toThrow("using your tab");
    expect(closedTargets).not.toContain("T_USER_BG");
    expect(closedTargets).not.toContain("T_USER");
    const { requests } = await runMock(
      "const p = await openTab('https://a.test/'); await p.goto('--show'); return 1;",
      (request) => {
        const argv = (request["argv"] as string[]) ?? [];
        if (argv[0] === "tab" && argv[1] === "new") return { ok: true, text: "", data: { tabId: "t1", targetId: "T1", url: "https://a.test/", owned: true } };
        return { ok: true, text: "", data: {} };
      },
    );
    expect(requests.find((r) => Array.isArray(r["argv"]) && r["argv"][0] === "open")?.["argv"]).toEqual(["open", "--", "--show"]);
  });

  test("a bound click --new-tab never moves the session's current tab", async () => {
    const { state, pages } = serverTestState();
    const own = pages.get("T_OWN")!;
    const refId = state.addRef(own as never, { backendId: 5, frame: own.mainFrame, objectId: "obj-5" } as never, "link", "Next");
    Object.assign(own, { state });
    const plain = own.call;
    own.call = async (fn: string) => (fn.includes("a[href]") ? "https://next.test/" : plain(fn));
    state.current = "T_SHADOW";
    let current = state.current as string | null;
    const seen: (string | null)[] = [];
    Object.defineProperty(state, "current", {
      configurable: true,
      get: () => current,
      set: (value: string | null) => {
        seen.push(value);
        current = value;
      },
    });
    const ctx = new Ctx(state, { timeout_ms: 300 }, process.cwd(), {}, null, "click");
    const lookup = state.page;
    state.page = async (target: string | null = null) => Object.assign(await lookup(target), { state, waitLoaded: async () => true });
    const clicked = await withTarget("T_OWN", () => dispatch(ctx, "click", [`@${refId}`, "--new-tab"]));
    const opened = (clicked.data as Record<string, unknown>)["newTab"];
    expect(typeof opened).toBe("string");
    expect([...state.tabIds.entries()].find(([, tab]) => tab === opened)?.[0]).toMatch(/^T_NEW_/);
    expect(seen.filter((value) => value !== "T_SHADOW")).toEqual([]);
    expect(state.current).toBe("T_SHADOW");
  });

  test("a fresh-tab open whose create reply lands after cancellation queues the late tab for closing", async () => {
    const { state, closedTargets } = serverTestState();
    state.current = null;
    let finish: (value: Record<string, unknown>) => void = () => undefined;
    const browser = state.browser as unknown as { send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>> };
    const send = browser.send;
    browser.send = (method, params) => (method === "Target.createTarget" ? new Promise((resolve) => (finish = resolve)) : send(method, params));
    const stop = new AbortController();
    const ctx = new Ctx(state, {}, process.cwd(), {}, null, "open");
    const opening = withSignal(stop.signal, () => cmdOpen(ctx, ["https://late.test/"]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    stop.abort();
    const outcome = await Promise.race([opening.then(() => "resolved", () => "rejected"), new Promise((resolve) => setTimeout(() => resolve("pending"), 1000))]);
    finish({ targetId: "T_LATE" });
    expect(outcome).toBe("rejected");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.mustClose.has("T_LATE") || closedTargets.includes("T_LATE")).toBe(true);
    state.mustCloseTask?.stop.abort();
  });

  test("closing a Page handle twice succeeds while an unknown id still fails, and a hold refusal is a per-call tab_closing error", async () => {
    const { state } = serverTestState();
    try {
      const ctx = new Ctx(
        state,
        {},
        process.cwd(),
        {},
        "const p = await openTab(); await p.close(); await p.close(); let unknown = null; try { await closeTab('nope-tab'); } catch (e) { unknown = e.code || e.message; } return unknown;",
        "script",
      );
      const res = await cmdScript(ctx, ["--repl"]);
      expect((res.data as { value: unknown }).value).toBeTruthy();
    } finally {
      dropRepl(state);
    }
    const second = serverTestState();
    try {
      second.state.registry.holding = (async () => {
        throw new BrowseError("That tab can't be used: another session is closing it", { targetId: "x" }, "tab_closing");
      }) as never;
      const ctx = new Ctx(second.state, {}, process.cwd(), {}, "const p = await openTab(); try { await p.title(); return 'no error'; } catch (e) { return e.code; }", "script");
      const res = await cmdScript(ctx, ["--repl"]);
      expect((res.data as { value: unknown }).value).toBe("tab_closing");
    } finally {
      dropRepl(second.state);
    }
  });

  test("read-urls on a closed bound tab fails without adopting the active tab", async () => {
    const { state } = serverTestState();
    const ctx = new Ctx(state, {}, process.cwd(), {}, null, "read-urls");
    await expect(withTarget("T_GONE", () => cmdReadUrls(ctx, ["https://a.test/"]))).rejects.toThrow("closed");
    expect(state.current).toBe("T_OWN");
    expect(state.attached).toBe("T_USER");
  });

  test("the large-tree fallback shows the full tree when reordering comes with an added line", async () => {
    const big = Array.from({ length: 501 }, (_, i) => `row ${i}`);
    const next = [...big];
    [next[0], next[1]] = [next[1] as string, next[0] as string];
    next.push("row added");
    const trees = [big.join("\n"), next.join("\n")];
    let step = 0;
    const { result } = await runMock(
      "const p = await openTab('https://big.test'); await snapshot(p); const s = await snapshot(p); return { diff: s.diff, full: s.text === s.tree };",
      (request) => {
        const argv = (request["argv"] as string[]) ?? [];
        if (argv[0] === "tab" && argv[1] === "new") return { ok: true, text: "", data: { tabId: "t9", targetId: "T9", url: "https://big.test/", owned: true } };
        if (argv[0] === "snapshot") return { ok: true, text: trees[Math.min(step++, 1)], data: {} };
        return { ok: true, text: "", data: {} };
      },
    );
    const value = result["value"] as Record<string, unknown>;
    expect(value["diff"]).toBeNull();
    expect(value["full"]).toBe(true);
  });

  test("an earlier unbound reply doesn't wipe a later bound receipt, and unbound answers refresh a bound handle's url()", async () => {
    const handler = (request: Record<string, unknown>) => {
      const argv = (request["argv"] as string[]) ?? [];
      if (argv[0] === "tab" && argv[1] === "new") return { ok: true, text: "", data: { tabId: "t1", targetId: "T1", url: "https://a.test/", owned: true } };
      if (argv[0] === "click") return { ok: true, text: "✓ clicked\nchanges\n  Saved", data: { changes: { text: { lines: ["Saved"] } } }, ranOn: "T1" };
      if (argv[0] === "fill") return { ok: true, text: "ok", data: {}, url: "https://b.test/next", ranOn: "T1" };
      return { ok: true, text: "ok", data: { title: "T" }, url: "https://a.test/", ranOn: "T1" };
    };
    const result = await runOrdered(
      `
        const p = await openTab('https://a.test/');
        await page.title();
        const filling = page.fill('#x', 'y');
        const clicking = p.act.click('#save');
        await clicking;
        await filling;
        return { kept: p.lastReceipt !== null, url: String(p.url()) };
      `,
      handler,
      (request) => {
        const argv = (request["argv"] as string[]) ?? [];
        if (argv[0] === "fill") return "hold:fill";
        if (argv[0] === "click") return "release:fill";
        return null;
      },
    );
    const value = result["value"] as Record<string, unknown>;
    expect(value["kept"]).toBe(true);
    expect(value["url"]).toBe("https://b.test/next");
  });
});

describe("third review round: late create on bound new-tab click, concurrent repeat close, batch repl", () => {
  test("a bound click --new-tab whose create reply lands after cancellation queues the late tab for closing", async () => {
    const { state, pages, closedTargets } = serverTestState();
    const own = pages.get("T_OWN")!;
    Object.assign(own, { state });
    const refId = state.addRef(own as never, { backendId: 5, frame: own.mainFrame, objectId: "obj-5" } as never, "link", "Next");
    const plain = own.call;
    own.call = async (fn: string) => (fn.includes("a[href]") ? "https://next.test/" : plain(fn));
    let finish: (value: Record<string, unknown>) => void = () => undefined;
    const browser = state.browser as unknown as { send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>> };
    const send = browser.send;
    browser.send = (method, params) => (method === "Target.createTarget" ? new Promise((resolve) => (finish = resolve)) : send(method, params));
    const stop = new AbortController();
    const ctx = new Ctx(state, {}, process.cwd(), {}, null, "click");
    const clicking = withSignal(stop.signal, () => withTarget("T_OWN", () => dispatch(ctx, "click", [`@${refId}`, "--new-tab"])));
    await new Promise((resolve) => setTimeout(resolve, 10));
    stop.abort();
    const outcome = await Promise.race([clicking.then(() => "resolved", () => "rejected"), new Promise((resolve) => setTimeout(() => resolve("pending"), 1000))]);
    finish({ targetId: "T_LATE_CLICK" });
    expect(outcome).toBe("rejected");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.mustClose.has("T_LATE_CLICK") || closedTargets.includes("T_LATE_CLICK")).toBe(true);
    state.mustCloseTask?.stop.abort();
  });

  test("two overlapping closes of one handle and two closes by tab id both succeed with the original tab id", async () => {
    const { state } = serverTestState();
    const browser = state.browser as unknown as { send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>> };
    const send = browser.send;
    browser.send = async (method, params) => {
      if (method === "Target.closeTarget") await new Promise((resolve) => setTimeout(resolve, 20));
      return send(method, params);
    };
    try {
      const ctx = new Ctx(
        state,
        {},
        process.cwd(),
        {},
        `
          const p = await openTab();
          const both = await Promise.allSettled([p.close(), p.close()]);
          const q = await openTab();
          const first = await closeTab(q.tabId);
          const again = await closeTab(q.tabId);
          return { both: both.map((r) => r.status), first: first.closed, again: again.closed, tabId: q.tabId };
        `,
        "script",
      );
      const res = await cmdScript(ctx, ["--repl"]);
      const value = (res.data as { value: Record<string, unknown> }).value;
      expect(value["both"]).toEqual(["fulfilled", "fulfilled"]);
      expect(value["first"]).toBe(value["tabId"]);
      expect(value["again"]).toBe(value["tabId"]);
    } finally {
      dropRepl(state);
    }
  });

  test("a batch repl line runs as script --repl and --out saves its value", async () => {
    const { state } = serverTestState();
    const dir = mkdtempSync(path.join(os.tmpdir(), "ardia-batch-repl-"));
    try {
      const ctx = new Ctx(state, {}, dir, {}, null, "batch");
      await dispatch(ctx, "batch", [JSON.stringify(["repl", "-e", "return 42", "--out", "result.json"])]);
      expect(readFileSync(path.join(dir, "result.json"), "utf8").trim()).toBe("42");
    } finally {
      dropRepl(state);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fourth review round (CodeRabbit)", () => {
  test("batch script and repl lines run their own -e source and never the batch's stdin", async () => {
    const { state } = serverTestState();
    const dir = mkdtempSync(path.join(os.tmpdir(), "ardia-batch-src-"));
    try {
      const ctx = new Ctx(state, {}, dir, {}, "return 99", "batch");
      await dispatch(ctx, "batch", [JSON.stringify(["script", "-e", "return 5", "--out", "five.json"]), JSON.stringify(["repl", "--out", "none.json"])]);
      expect(readFileSync(path.join(dir, "five.json"), "utf8").trim()).toBe("5");
      expect(() => readFileSync(path.join(dir, "none.json"), "utf8")).toThrow();
    } finally {
      dropRepl(state);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a bound open --here is refused even on the tab picked with tab active", async () => {
    const { state } = serverTestState();
    const ctx = new Ctx(state, {}, process.cwd(), {}, null, "open");
    await expect(withTarget("T_USER", () => cmdOpen(ctx, ["--here", "https://evil.test/"]))).rejects.toThrow("only runs outside a tab handle");
  });

  test("read-urls refreshes targets before calling a bound tab closed", async () => {
    const { state } = serverTestState();
    const info = state.targetInfos.get("T_SHADOW");
    state.targetInfos.delete("T_SHADOW");
    state.refreshTargets = async () => {
      state.targetInfos.set("T_SHADOW", info as never);
      return [...state.targetInfos.values()];
    };
    const ctx = new Ctx(state, {}, process.cwd(), {}, null, "read-urls");
    await expect(withTarget("T_SHADOW", () => cmdReadUrls(ctx, ["https://a.test/"]))).rejects.toThrow("no answer");
  });

  test("a closed handle's receipt is cleared, so assertText reads the page", async () => {
    const { result } = await runMock(
      `
        const p = await openTab('https://a.test');
        await p.act.click('#save');
        await closeTab(p);
        return await p.assertText('Saved').then(() => 'from stale receipt', () => 'read the page');
      `,
      (request) => {
        const argv = (request["argv"] as string[]) ?? [];
        if (argv[0] === "tab" && argv[1] === "new") return { ok: true, text: "", data: { tabId: "t1", targetId: "T1", url: "https://a.test/", owned: true } };
        if (argv[0] === "click") return { ok: true, text: "✓ clicked\nchanges\n  Saved", data: { changes: { text: { lines: ["Saved"] } } } };
        if (argv[0] === "tab" && argv[1] === "close") return { ok: true, text: "", data: { closed: "t1", targetId: "T1" } };
        if (argv[0] === "get" && argv[1] === "text") return { ok: true, text: "nothing", data: { text: "nothing" } };
        return { ok: true, text: "ok", data: {} };
      },
    );
    expect(result["value"]).toBe("read the page");
  });

  test("an unbound call whose current tab changed while it waited re-resolves under the new tab's gate", async () => {
    const { state } = serverTestState();
    const run = new ScriptRun(new Ctx(state, {}, process.cwd(), {}, null, "script"), null as never);
    state.current = "T_OWN";
    const seen: (string | null)[] = [];
    const out = await run.runGated(null, false, async (resolved) => {
      seen.push(resolved);
      if (seen.length === 1) state.current = "T_SHADOW";
      return run.moved(null, resolved) ? MOVED : resolved;
    });
    expect(out).toBe("T_SHADOW");
    expect(seen).toEqual(["T_OWN", "T_SHADOW"]);
  });

  test("a bound call on the current tab still holds that tab in the registry", async () => {
    const { state } = serverTestState();
    const held: string[] = [];
    const holding = state.registry.holding.bind(state.registry);
    state.registry.holding = (async (instance: never, target: string, work: () => Promise<unknown>) => {
      held.push(target);
      return holding(instance, target, work as never);
    }) as never;
    try {
      const ctx = new Ctx(state, {}, process.cwd(), {}, "const p = await getTabByTargetId('T_OWN'); await page.title(); return await p.title();", "script");
      const res = await cmdScript(ctx, ["--repl"]);
      expect((res.data as { value: unknown }).value).toBe("Title-T_OWN");
      expect(held).toEqual(["T_OWN"]);
    } finally {
      dropRepl(state);
    }
  });

  test("a page-initiated navigation reaches a bound handle's url() with no command in between", async () => {
    const { state } = serverTestState();
    const own = state.pages.get("T_OWN") as unknown as Record<string, unknown>;
    Object.assign(own, { state, worlds: new Map(), framesChanged: () => undefined, runtimeContextEvent: () => undefined, session: null });
    try {
      const first = await cmdScript(new Ctx(state, {}, process.cwd(), {}, "const p = await getTabByTargetId('T_OWN'); return String(p.url());", "script"), ["--repl"]);
      expect((first.data as { value: unknown }).value).toBe("https://own.test/");
      Page.prototype.onEvent.call(own as never, "Page.frameNavigated", { frame: { id: "F-T_OWN", url: "https://own.test/redirected", securityOrigin: "https://own.test", loaderId: "L2" } } as never);
      Page.prototype.onEvent.call(own as never, "Page.navigatedWithinDocument", { frameId: "F-T_OWN", url: "https://own.test/redirected#done" } as never);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = await cmdScript(new Ctx(state, {}, process.cwd(), {}, "return String(p.url());", "script"), ["--repl"]);
      expect((second.data as { value: unknown }).value).toBe("https://own.test/redirected#done");
    } finally {
      dropRepl(state);
    }
  });

  test("calls dropped while waiting for a run slot are counted", async () => {
    const sem = new RunSemaphore(1);
    let release: () => void = () => undefined;
    const running = sem.run(() => new Promise<void>((resolve) => (release = resolve)));
    const waiting = sem.run(async () => undefined).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 5));
    sem.close();
    release();
    await running;
    expect(await waiting).toBeInstanceOf(Error);
    expect(sem.dropped).toBe(1);
  });
});

describe("fifth review round", () => {
  test("an unbound call whose current tab changes on every attempt fails with tab_moved and never runs", async () => {
    const { state, pages } = serverTestState();
    let evaluated = 0;
    for (const page of pages.values()) {
      const plain = page.send;
      page.send = async (method: string, ...rest: unknown[]) => {
        if (method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") evaluated += 1;
        return (plain as (m: string, ...r: unknown[]) => Promise<unknown>)(method, ...rest) as never;
      };
    }
    const cycle = ["T_OWN", "T_SHADOW"];
    let reads = 0;
    try {
      const ctx = new Ctx(state, {}, process.cwd(), {}, "try { await page.evaluate('1 + 1'); return 'ran'; } catch (e) { return e.code; }", "script");
      Object.defineProperty(state, "current", { configurable: true, get: () => cycle[reads++ % 2], set: () => undefined });
      const res = await cmdScript(ctx, []);
      expect((res.data as { value: unknown }).value).toBe("tab_moved");
      expect(evaluated).toBe(0);
    } finally {
      Object.defineProperty(state, "current", { configurable: true, writable: true, value: "T_OWN" });
    }
  });

  test("a handle on a tab with no page session follows its URL from target info changes", async () => {
    const { state } = serverTestState();
    state.targetInfos.set("T_UNATT", { targetId: "T_UNATT", type: "page", url: "https://far.test/start", title: "Far" });
    state.tabId("T_UNATT");
    try {
      const first = await cmdScript(new Ctx(state, {}, process.cwd(), {}, "const q = await getTabByTargetId('T_UNATT'); return String(q.url());", "script"), ["--repl"]);
      expect((first.data as { value: unknown }).value).toBe("https://far.test/start");
      state.onEvent("Target.targetInfoChanged", { targetInfo: { targetId: "T_UNATT", type: "page", url: "https://far.test/moved", title: "Far" } }, undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = await cmdScript(new Ctx(state, {}, process.cwd(), {}, "return String(q.url());", "script"), ["--repl"]);
      expect((second.data as { value: unknown }).value).toBe("https://far.test/moved");
    } finally {
      dropRepl(state);
    }
  });

  test("a cached page whose session detached still follows its URL from target info changes", async () => {
    const { state } = serverTestState();
    const own = state.pages.get("T_OWN") as unknown as Record<string, unknown>;
    own["sessionId"] = null;
    try {
      const first = await cmdScript(new Ctx(state, {}, process.cwd(), {}, "const d = await getTabByTargetId('T_OWN'); return String(d.url());", "script"), ["--repl"]);
      expect((first.data as { value: unknown }).value).toBe("https://own.test/");
      state.onEvent("Target.targetInfoChanged", { targetInfo: { targetId: "T_OWN", type: "page", url: "https://own.test/elsewhere", title: "Own" } }, undefined);
      state.onEvent("Target.targetInfoChanged", { targetInfo: { targetId: "T_NEVER_SEEN", type: "page", url: "https://unknown.test/", title: "?" } }, undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = await cmdScript(new Ctx(state, {}, process.cwd(), {}, "return String(d.url());", "script"), ["--repl"]);
      expect((second.data as { value: unknown }).value).toBe("https://own.test/elsewhere");
    } finally {
      dropRepl(state);
    }
  });

  test("a batch repl line whose code is --help runs it instead of showing help", async () => {
    const { state } = serverTestState();
    const dir = mkdtempSync(path.join(os.tmpdir(), "ardia-batch-help-"));
    try {
      const ctx = new Ctx(state, {}, dir, {}, null, "batch");
      await dispatch(ctx, "batch", [
        JSON.stringify(["repl", "-e", "globalThis.help = 5"]),
        JSON.stringify(["repl", "-e", "--help"]),
        JSON.stringify(["repl", "-e", "return help", "--out", "help.json"]),
      ]);
      expect(readFileSync(path.join(dir, "help.json"), "utf8").trim()).toBe("4");
    } finally {
      dropRepl(state);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("batch script and repl lines asking for --help get the help text", async () => {
    const { state } = serverTestState();
    const ctx = new Ctx(state, {}, process.cwd(), {}, null, "batch");
    const result = await dispatch(ctx, "batch", [JSON.stringify(["script", "--help"]), JSON.stringify(["repl", "-h"])]);
    expect(result.text).not.toContain("Unknown flag");
    expect(result.text).toContain("ardia");
  });

  test("an unbound call that follows a lost tab waits for a bound exclusive call already on the replacement", async () => {
    const { state, pages } = serverTestState();
    let active = 0;
    let peak = 0;
    let reached = 0;
    let replacement: string | null = null;
    for (const page of pages.values()) Object.assign(page, { sessionId: "S", browser: state.browser, needsEnable: false, state });
    const created = state.noteTabCreated.bind(state);
    state.noteTabCreated = (id: string) => {
      replacement = id;
      created(id);
      const page = pages.get(id) as unknown as Record<string, unknown>;
      const plainSend = page["send"] as (method: string, ...rest: unknown[]) => Promise<unknown>;
      Object.assign(page, {
        sessionId: "S",
        browser: state.browser,
        needsEnable: false,
        state,
        send: async (method: string, ...rest: unknown[]) => {
          if (method !== "Runtime.evaluate" && method !== "Runtime.callFunctionOn") return plainSend(method, ...rest);
          active += 1;
          reached += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 40));
          active -= 1;
          return { result: { type: "boolean", value: true } };
        },
      });
    };
    state.page = State.prototype.page.bind(state);
    state.followLostTab = async () => {
      state.current = replacement;
      state.lostTab = null;
      return String(replacement);
    };
    try {
      const ctx = new Ctx(
        state,
        { timeout_ms: 2000 },
        process.cwd(),
        {},
        `
          const p = await openTab(undefined, { background: true });
          const waiting = p.waitForFunction('true');
          const evaluating = page.evaluate('1 + 1');
          const [, evaluated] = await Promise.all([waiting, evaluating]);
          return { id: p.targetId, evaluated };
        `,
        "script",
      );
      state.current = null;
      state.lostTab = { target: "T_LOST", tab: "t99", app: "A1", borrowed: false, opened: true } as never;
      const res = await cmdScript(ctx, ["--repl"]);
      expect((res.data as { value: unknown }).value).toEqual({ id: replacement, evaluated: true });
      expect(reached).toBeGreaterThanOrEqual(2);
      expect(peak).toBe(1);
    } finally {
      dropRepl(state);
    }
  });

  test("an unbound call that adopts the active tab waits for a bound exclusive call already on that tab", async () => {
    const { state, pages } = serverTestState();
    let active = 0;
    let peak = 0;
    let adopted: string | null = null;
    state.current = null;
    state.hadTab = false;
    const lookup = state.page;
    state.page = async (target: string | null = null) => {
      if (target === null && activeTarget(state) === null) throw new BrowseError("no tab", null, "no_session_tab");
      const page = (await lookup(target)) as unknown as Record<string, unknown>;
      if (page["slowed"] !== true) {
        const plain = page["call"] as (fn: string, ...rest: unknown[]) => Promise<unknown>;
        const plainSend = page["send"] as (method: string, ...rest: unknown[]) => Promise<unknown>;
        Object.assign(page, {
          slowed: true,
          state,
          send: async (method: string, ...rest: unknown[]) => {
            if (method !== "Runtime.evaluate" && method !== "Runtime.callFunctionOn") return plainSend(method, ...rest);
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 40));
            active -= 1;
            return { result: { type: "boolean", value: true } };
          },
          call: async (fn: string, ...rest: unknown[]) => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 40));
            active -= 1;
            return fn.includes("wait") || fn.includes("=>") ? true : plain(fn, ...rest);
          },
        });
      }
      return page as never;
    };
    state.takeActive = async () => {
      state.current = adopted;
      state.hadTab = true;
      return adopted as string;
    };
    try {
      const ctx = new Ctx(
        state,
        { timeout_ms: 2000 },
        process.cwd(),
        {},
        `
          const p = await openTab(undefined, { background: true });
          globalThis.adoptedId = p.targetId;
          const waiting = p.waitForFunction('true');
          const evaluating = page.evaluate('1 + 1');
          await Promise.allSettled([waiting, evaluating]);
          return p.targetId;
        `,
        "script",
      );
      const created = state.noteTabCreated.bind(state);
      state.noteTabCreated = (id: string) => {
        adopted = id;
        created(id);
      };
      const res = await cmdScript(ctx, ["--repl"]);
      expect((res.data as { value: unknown }).value).toBe(adopted);
      expect(pages.has(String(adopted))).toBe(true);
      expect(peak).toBe(1);
    } finally {
      dropRepl(state);
    }
  });
});

function serverTestState() {
  const state = new State({ session: "srv-test", key: "", browseFd: null, noAutoDialog: false, pinTab: false }, () => Promise.reject(new Error("unused")));
  const closedTargets: string[] = [];
  let failCloseFor: string | null = null;
  let nextCreated = 10;
  const makeFakePage = (targetId: string, url: string) => ({
    targetId,
    url,
    crashed: false,
    dialog: null,
    mainFrame: `F-${targetId}`,
    frames: new Map([[`F-${targetId}`, { id: `F-${targetId}`, parent: null, url, name: "", origin: new URL(url).origin, loader: `L-${targetId}` }]]),
    frameSessions: new Map(),
    sessionFor: () => null,
    loader: () => `L-${targetId}`,
    detach: () => undefined,
    refreshFrames: async () => undefined,
    resolveBackend: async (backendId: number, frame: string) => ({ backendId, frame, objectId: `obj-${backendId}` }),
    call: async (fn: string) => {
      if (fn.includes("isConnected")) return true;
      if (fn.includes("document.title")) return `Title-${targetId}`;
      if (fn.includes("queryAll(s).slice")) return targetId === "T_SHADOW" ? [] : ["Alpha", "Beta"];
      if (fn.includes("() => document")) return { objectId: "doc-1" };
      if (fn.includes("ardiaBrowse.queryAll(s, root)")) return ["ShadowOne", "ShadowTwo"];
      if (fn.includes("WATCH_REACTION") || fn.includes("watchId") || fn.includes("mutation")) return true;
      return {};
    },
    send: async (method: string) => {
      if (method === "DOM.describeNode") return { node: { shadowRoots: [{ shadowRootType: "open", backendNodeId: 77 }], children: [] } };
      return {};
    },
  });
  const pages = new Map<string, ReturnType<typeof makeFakePage>>([
    ["T_USER", makeFakePage("T_USER", "https://user.test/")],
    ["T_USER_BG", makeFakePage("T_USER_BG", "https://user-bg.test/")],
    ["T_OWN", makeFakePage("T_OWN", "https://own.test/")],
    ["T_SHADOW", makeFakePage("T_SHADOW", "https://shadow.test/")],
  ]);
  for (const [id, page] of pages) {
    state.targetInfos.set(id, { targetId: id, type: "page", url: page.url, title: `Title-${id}` });
    state.pages.set(id, page as never);
    state.tabId(id);
  }
  state.opened.add("T_OWN");
  state.opened.add("T_SHADOW");
  state.created.add("T_OWN");
  state.attached = "T_USER";
  state.current = "T_OWN";
  state.hadTab = true;
  state.browser = {
    alive: true,
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method === "Target.createTarget") {
        const id = `T_NEW_${nextCreated++}`;
        const p = makeFakePage(id, "https://new.test/");
        pages.set(id, p);
        state.targetInfos.set(id, { targetId: id, type: "page", url: p.url, title: `Title-${id}` });
        state.pages.set(id, p as never);
        return { targetId: id };
      }
      if (method === "Target.getTargets") {
        return { targetInfos: [...state.targetInfos.values()] };
      }
      if (method === "Target.closeTarget") {
        const id = String(params?.["targetId"] ?? "");
        if (failCloseFor === id) throw new Error("close failed");
        closedTargets.push(id);
        state.targetInfos.delete(id);
        return { success: true };
      }
      return {};
    },
  } as never;
  state.connect = async () => undefined;
  state.refreshTargets = async () => [...state.targetInfos.values()];
  state.readoptOpenedTabs = async () => undefined;
  state.reattach = async (p) => p;
  state.page = async (target: string | null = null) => {
    const id = target ?? activeTarget(state);
    if (!id || !pages.has(id)) throw new BrowseError("That tab was closed", { targetId: id }, "tab_gone");
    return pages.get(id) as never;
  };
  return {
    state,
    pages,
    closedTargets,
    setFailClose: (id: string | null) => {
      failCloseFor = id;
    },
  };
}

describe("server-side target isolation, borrowed tab safety, reactions, get texts and --close", () => {
  test("withTarget isolates ref resolution, dialog lookup, and borrowed-tab protections", async () => {
    const { state, pages } = serverTestState();
    const userPage = pages.get("T_USER")!;
    const ownPage = pages.get("T_OWN")!;
    const refId = state.addRef(ownPage as never, { backendId: 5, frame: ownPage.mainFrame, objectId: "obj-5" } as never, "button", "Save");

    const [resolvedPage] = await withTarget("T_OWN", () => state.locate(`@${refId}`));
    expect(resolvedPage.targetId).toBe("T_OWN");

    await expect(withTarget("T_USER", () => state.locate(`@${refId}`))).rejects.toThrow("different tab");

    await expect(withTarget("T_USER", async () => pageForSelector(state, null)?.targetId)).resolves.toBe("T_USER");

    const ctx = new Ctx(state, {}, process.cwd(), {}, null, "open");
    await expect(withTarget("T_USER", () => cmdOpen(ctx, ["https://evil.test/"]))).rejects.toThrow("using your tab");
    expect(() => refuseOnBorrowed(ctx, userPage as never, "reload")).toThrow("using your tab");

    const bgUser = pages.get("T_USER_BG")!;
    await expect(withTarget("T_USER_BG", () => cmdOpen(ctx, ["https://evil.test/"]))).rejects.toThrow("using your tab");
    await expect(withTarget("T_USER_BG", async () => refuseOnBorrowed(ctx, bgUser as never, "reload"))).rejects.toThrow("using your tab");

    const [plainResolved] = await state.locate(`@${refId}`, userPage as never);
    expect(plainResolved.targetId).toBe("T_OWN");
  });

  test("closeTab detaches borrowed user tabs, closes owned tabs, and rejects unknown ids", async () => {
    const { state, closedTargets } = serverTestState();
    const ctx = new Ctx(state, {}, process.cwd(), {}, null, "tab");

    const detached = await closeTab(ctx, "T_USER", { detachBorrowed: true });
    expect((detached.data as Record<string, unknown>)["detached"]).toBeDefined();
    expect(closedTargets).not.toContain("T_USER");
    expect(state.attached).toBeNull();

    const closed = await closeTab(ctx, "T_OWN", { detachBorrowed: true });
    expect((closed.data as Record<string, unknown>)["closed"]).toBeDefined();
    expect(closedTargets).toContain("T_OWN");

    await expect(closeTab(ctx, "nonexistent-tab-typo", { detachBorrowed: true })).rejects.toThrow();
  });

  test("get texts reads light DOM in one call and falls back to shadow DOM pierce", async () => {
    const { state } = serverTestState();
    const ctx = new Ctx(state, {}, process.cwd(), {}, null, "get");

    const light = await withTarget("T_OWN", () => cmdGet(ctx, ["texts", "li"]));
    expect((light.data as Record<string, unknown>)["texts"]).toEqual(["Alpha", "Beta"]);

    const shadow = await withTarget("T_SHADOW", () => cmdGet(ctx, ["texts", "ytd-item"]));
    expect((shadow.data as Record<string, unknown>)["texts"]).toEqual(["ShadowOne", "ShadowTwo"]);
  });

  test("pending reactions are isolated per target", async () => {
    const { state, pages } = serverTestState();
    await watchReaction(state, pages.get("T_OWN") as never, [null, "F-T_OWN"]);
    await watchReaction(state, pages.get("T_SHADOW") as never, [null, "F-T_SHADOW"]);
    expect(hasPendingReaction(state, "T_OWN")).toBe(true);
    expect(hasPendingReaction(state, "T_SHADOW")).toBe(true);

    await settleReaction(state, "get", ["text"], "T_SHADOW");
    expect(hasPendingReaction(state, "T_SHADOW")).toBe(false);
    expect(hasPendingReaction(state, "T_OWN")).toBe(true);
  });

  test("--close tracks tabs opened via openTab/tab new and preserves ownership if close fails", async () => {
    const { state, closedTargets, setFailClose } = serverTestState();
    try {
      const ctx = new Ctx(state, {}, process.cwd(), {}, "const p = await openTab(); return p.targetId;", "script");
      const res = await cmdScript(ctx, ["--repl", "--close"]);
      const createdId = (res.data as { value: string }).value;
      expect(closedTargets).toContain(createdId);
      expect(state.targetInfos.has(createdId)).toBe(false);

      const failId = "T_NEW_11";
      setFailClose(failId);
      const ctx2 = new Ctx(state, {}, process.cwd(), {}, "const p = await openTab(); return p.targetId;", "script");
      const res2 = await cmdScript(ctx2, ["--repl", "--close"]);
      expect((res2.data as { value: string }).value).toBe(failId);
      expect(state.mustClose.has(failId)).toBe(true);
      expect(state.targetInfos.has(failId)).toBe(true);
    } finally {
      state.mustCloseTask?.stop.abort();
      dropRepl(state);
    }
  });

  test("withTab keeps original state.current, failed openTab closes leaked tab without --close, RunSemaphore caps concurrency, and telemetry metrics pass both allowlists", async () => {
    const { state, closedTargets } = serverTestState();
    state.labels.set("taken", "T_OWN");
    try {
      const ctx = new Ctx(
        state,
        {},
        process.cwd(),
        {},
        `
          const inner = await withTab(undefined, async (t) => await t.title());
          const after = await page.title();
          let failedMsg = null;
          try {
            await openTab(undefined, { label: "taken" });
          } catch (e) {
            failedMsg = e.message;
          }
          return { inner, after, failedMsg };
        `,
        "script",
      );
      const res = await cmdScript(ctx, ["--repl"]);
      const out = (res.data as { value: Record<string, unknown> }).value;
      expect(out["inner"]).toBe("Title-T_NEW_10");
      expect(out["after"]).toBe("Title-T_OWN");
      expect(state.current).toBe("T_OWN");
      expect(String(out["failedMsg"])).toContain("taken");
      expect(closedTargets).toContain("T_NEW_10");
      expect(closedTargets).toContain("T_NEW_11");
      expect(state.targetInfos.has("T_NEW_11")).toBe(false);
    } finally {
      dropRepl(state);
    }

    const sem = new RunSemaphore(3);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 24 }, (_, idx) =>
        sem.run(async () => {
          active += 1;
          if (active > peak) peak = active;
          await new Promise((r) => setTimeout(r, idx % 3 === 0 ? 4 : 1));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(active).toBe(0);

    for (const flagName of ["script_repl_autoclose", "script_tab_detached"]) {
      expect(DAEMON_FLAGS.has(flagName)).toBe(true);
      expect(isMetricFlag(flagName)).toBe(true);
    }
    expect(DAEMON_COUNTS.has("script_repl_autoclosed")).toBe(true);
    expect(isMetricCount("script_repl_autoclosed")).toBe(true);
  });
});
