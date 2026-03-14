import WebSocket from "ws";
import type { CashClawConfig } from "./config.js";
import type { LLMProvider } from "./llm/types.js";
import type { Task } from "./moltlaunch/types.js";
import * as cli from "./moltlaunch/cli.js";
import { runAgentLoop, type LoopResult } from "./loop/index.js";
import { runStudySession } from "./loop/study.js";
import { storeFeedback } from "./memory/feedback.js";
import { appendLog } from "./memory/log.js";

export interface HeartbeatState {
  running: boolean;
  activeTasks: Map<string, Task>;
  lastPoll: number;
  totalPolls: number;
  startedAt: number;
  events: ActivityEvent[];
  wsConnected: boolean;
  lastStudyTime: number;
  totalStudySessions: number;
}

export interface ActivityEvent {
  timestamp: number;
  type: "poll" | "loop_start" | "loop_complete" | "tool_call" | "feedback" | "error" | "ws" | "study" | "task_terminal";
  taskId?: string;
  message: string;
  /** task_terminal イベント用: 終端ステータス名 */
  terminalStatus?: string;
}

type EventListener = (event: ActivityEvent) => void;

const TERMINAL_STATUSES = new Set([
  "completed", "declined", "cancelled", "expired", "resolved", "disputed",
]);

const WS_URL = "wss://api.moltlaunch.com/ws";
const WS_INITIAL_RECONNECT_MS = 5_000;
const WS_MAX_RECONNECT_MS = 300_000; // 5 min cap
// When WS is connected, poll infrequently as a sync check
const WS_POLL_INTERVAL_MS = 120_000;
// Keepalive ping interval — prevents idle timeout from servers/proxies
const WS_PING_INTERVAL_MS = 30_000;
// Expire non-terminal tasks after 7 days to prevent memory leaks
const TASK_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export function createHeartbeat(
  config: CashClawConfig,
  llm: LLMProvider,
) {
  const state: HeartbeatState = {
    running: false,
    activeTasks: new Map(),
    lastPoll: 0,
    totalPolls: 0,
    startedAt: 0,
    events: [],
    wsConnected: false,
    lastStudyTime: 0,
    totalStudySessions: 0,
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let ws: WebSocket | null = null;
  let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let wsPingTimer: ReturnType<typeof setInterval> | null = null;
  let wsReconnectDelay = WS_INITIAL_RECONNECT_MS;
  let wsFailLogged = false;
  const processing = new Set<string>();
  const completedTasks = new Set<string>();
  // Track tasks that completed without rating yet (so we can dedup the approval notification)
  const approvedTasks = new Set<string>();
  // Track task+status combos to prevent duplicate processing from WS+poll overlap
  const processedVersions = new Map<string, string>();
  const listeners: EventListener[] = [];
  // Track bounties we've already claimed (prevents duplicate claim attempts)
  const claimedBounties = new Set<string>();
  // Lazy-loaded wallet address for filtering out our own bounties
  let ourWalletAddress = "";

  function emit(event: Omit<ActivityEvent, "timestamp">) {
    const full: ActivityEvent = { ...event, timestamp: Date.now() };
    state.events.push(full);
    if (state.events.length > 200) {
      state.events = state.events.slice(-200);
    }
    for (const fn of listeners) fn(full);
  }

  function onEvent(fn: EventListener) {
    listeners.push(fn);
  }

  // --- WebSocket ---

  function connectWs() {
    if (!state.running || !config.agentId) return;

    try {
      ws = new WebSocket(`${WS_URL}/${config.agentId}`);

      ws.on("open", () => {
        state.wsConnected = true;
        wsReconnectDelay = WS_INITIAL_RECONNECT_MS;
        wsFailLogged = false;
        emit({ type: "ws", message: "WebSocket connected" });
        appendLog("WebSocket connected");
        // Keepalive: send periodic pings to prevent idle timeout
        wsPingTimer = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.ping();
          }
        }, WS_PING_INTERVAL_MS);
      });

      ws.on("message", (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString()) as {
            event: string;
            task?: Task;
            timestamp?: number;
          };

          if (msg.event === "connected") return;

          emit({ type: "ws", taskId: msg.task?.id, message: `WS event: ${msg.event}` });

          if (msg.task) {
            handleTaskEvent(msg.task);
          }
        } catch {
          // Ignore malformed messages
        }
      });

      ws.on("close", () => {
        state.wsConnected = false;
        if (wsPingTimer) {
          clearInterval(wsPingTimer);
          wsPingTimer = null;
        }
        // Only log the first disconnect, suppress repeated failures
        if (!wsFailLogged) {
          emit({ type: "ws", message: "WebSocket disconnected — retrying in background" });
          wsFailLogged = true;
        }
        scheduleWsReconnect();
      });

      ws.on("error", (err: Error) => {
        state.wsConnected = false;
        if (!wsFailLogged) {
          emit({ type: "error", message: `WebSocket error: ${err.message}` });
          wsFailLogged = true;
        }
        ws?.close();
        scheduleWsReconnect();
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!wsFailLogged) {
        emit({ type: "error", message: `WebSocket connect failed: ${msg}` });
        wsFailLogged = true;
      }
      scheduleWsReconnect();
    }
  }

  function scheduleWsReconnect() {
    if (!state.running) return;
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(() => connectWs(), wsReconnectDelay);
    // Exponential backoff: 5s → 10s → 20s → 40s → ... → 5min cap
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_MAX_RECONNECT_MS);
  }

  function disconnectWs() {
    if (wsPingTimer) {
      clearInterval(wsPingTimer);
      wsPingTimer = null;
    }
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
    if (ws) {
      ws.removeAllListeners();
      ws.close();
      ws = null;
    }
    state.wsConnected = false;
  }

  // --- Task handling (shared by WS + poll) ---

  function handleTaskEvent(task: Task) {
    if (TERMINAL_STATUSES.has(task.status)) {
      if (task.status === "completed") {
        handleCompleted(task);
      } else if (
        task.status === "cancelled" ||
        task.status === "expired" ||
        task.status === "disputed" ||
        task.status === "resolved"
      ) {
        // Only emit once per task+status
        const version = `${task.id}:${task.status}`;
        if (processedVersions.get(task.id) !== version) {
          processedVersions.set(task.id, version);
          emit({
            type: "task_terminal",
            taskId: task.id,
            terminalStatus: task.status,
            message: `Task ${task.status}: ${task.id}`,
          });
          appendLog(`Task ${task.id} terminal: ${task.status}`);
        }
      }
      state.activeTasks.delete(task.id);
      processedVersions.delete(task.id);
      return;
    }

    // Dedup: skip if we already processed this exact task+status combo
    const version = `${task.id}:${task.status}`;
    if (processedVersions.get(task.id) === version && !processing.has(task.id)) {
      state.activeTasks.set(task.id, task);
      return;
    }

    if (processing.has(task.id)) return;

    if (task.status === "quoted" || task.status === "submitted") {
      state.activeTasks.set(task.id, task);
      processedVersions.set(task.id, version);
      return;
    }

    if (processing.size >= config.maxConcurrentTasks) return;

    state.activeTasks.set(task.id, task);
    processedVersions.set(task.id, version);
    processing.add(task.id);

    emit({ type: "loop_start", taskId: task.id, message: `Agent loop started (${task.status})` });
    appendLog(`Agent loop started for ${task.id} (${task.status})`);

    runAgentLoop(llm, task, config)
      .then((result: LoopResult) => {
        const toolNames = result.toolCalls.map((tc) => tc.name).join(", ");
        emit({
          type: "loop_complete",
          taskId: task.id,
          message: `Loop done in ${result.turns} turn(s): [${toolNames}]`,
        });
        appendLog(`Loop done for ${task.id}: ${result.turns} turns, tools=[${toolNames}]`);

        for (const tc of result.toolCalls) {
          emit({
            type: "tool_call",
            taskId: task.id,
            message: `${tc.name}(${JSON.stringify(tc.input).slice(0, 100)}) → ${tc.success ? "ok" : "err"}`,
          });
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ type: "error", taskId: task.id, message: `Loop error: ${msg}` });
        appendLog(`Loop error for ${task.id}: ${msg}`);
      })
      .finally(() => {
        processing.delete(task.id);
      });
  }

  // --- Bounty hunting ---

  async function checkBounties(): Promise<void> {
    // Lazy-init our wallet address to filter out self-posted bounties
    if (!ourWalletAddress) {
      try {
        const wi = await cli.walletShow();
        ourWalletAddress = wi.address.toLowerCase();
      } catch {
        return;
      }
    }

    let bounties: import("./moltlaunch/types.js").Bounty[];
    try {
      bounties = await cli.getBounties();
    } catch {
      return; // Non-critical — silently skip on error
    }

    for (const bounty of bounties) {
      // Skip our own bounties (self-claiming is pointless)
      if (bounty.clientAddress.toLowerCase() === ourWalletAddress) continue;
      // Skip already claimed
      if (claimedBounties.has(bounty.id)) continue;

      claimedBounties.add(bounty.id);

      try {
        await cli.claimBounty(bounty.id);
        emit({ type: "poll", message: `Claimed bounty ${bounty.id}: ${bounty.task.slice(0, 80)}` });
        appendLog(`Claimed bounty ${bounty.id}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ type: "error", message: `Bounty claim failed (${bounty.id}): ${msg}` });
        // Keep in claimedBounties to avoid retry spam on already-taken bounties
      }
    }
  }

  // --- Polling (fallback / sync check) ---

  async function tick() {
    try {
      const tasks = await cli.getInbox(config.agentId);
      state.lastPoll = Date.now();
      state.totalPolls++;

      emit({ type: "poll", message: `Polled inbox: ${tasks.length} task(s)` });
      appendLog(`Polled inbox — ${tasks.length} task(s)`);

      for (const task of tasks) {
        handleTaskEvent(task);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit({ type: "error", message: `Poll error: ${msg}` });
      appendLog(`Poll error: ${msg}`);
    }

    // Proactively hunt for open bounties on every tick
    await checkBounties();

    scheduleNext();
  }

  function weiToEth(wei: string): string {
    try {
      const eth = Number(BigInt(wei)) / 1e18;
      return eth.toFixed(4);
    } catch {
      return "?";
    }
  }

  function handleCompleted(task: Task) {
    const ethAmount = task.quotedPriceWei ? weiToEth(task.quotedPriceWei) : undefined;
    const ethSuffix = ethAmount ? ` — ${ethAmount} ETH` : "";

    if (task.ratedScore !== undefined) {
      // Rated completion: store feedback and notify (dedup by completedTasks)
      if (completedTasks.has(task.id)) return;
      completedTasks.add(task.id);
      approvedTasks.add(task.id); // Mark as fully done

      storeFeedback({
        taskId: task.id,
        taskDescription: task.task,
        score: task.ratedScore,
        comments: task.ratedComment ?? "",
        timestamp: Date.now(),
      });

      emit({
        type: "feedback",
        taskId: task.id,
        message: `Completed — rated ${task.ratedScore}/5${ethSuffix}${task.ratedComment ? ` — "${task.ratedComment}"` : ""}`,
      });
      appendLog(`Task ${task.id} completed — score ${task.ratedScore}/5${ethSuffix}`);
    } else {
      // Approved without rating yet: notify once (dedup by approvedTasks)
      if (approvedTasks.has(task.id)) return;
      approvedTasks.add(task.id);

      emit({
        type: "task_terminal",
        taskId: task.id,
        terminalStatus: "completed",
        message: `Task approved (awaiting rating): ${task.id}${ethSuffix}`,
      });
      appendLog(`Task ${task.id} approved — awaiting rating${ethSuffix}`);
    }
  }

  function scheduleNext() {
    if (!state.running) return;

    // Expire stale non-terminal tasks to prevent memory leaks
    const now = Date.now();
    for (const [id, task] of state.activeTasks) {
      const taskTime = task.quotedAt ?? task.acceptedAt ?? task.submittedAt ?? state.startedAt;
      if (!processing.has(id) && now - taskTime > TASK_EXPIRY_MS) {
        state.activeTasks.delete(id);
        processedVersions.delete(id);
      }
    }

    // Check if we should study while idle
    void maybeStudy();

    // If WebSocket is connected, poll infrequently as a sync check
    if (state.wsConnected) {
      timer = setTimeout(() => void tick(), WS_POLL_INTERVAL_MS);
      return;
    }

    // Without WS, use normal polling intervals
    const hasUrgent = [...state.activeTasks.values()].some(
      (t) => t.status === "requested" || t.status === "revision" || t.status === "accepted",
    );

    const interval = hasUrgent
      ? config.polling.urgentIntervalMs
      : config.polling.intervalMs;

    timer = setTimeout(() => void tick(), interval);
  }

  let studying = false;

  async function maybeStudy() {
    if (!config.learningEnabled) return;
    if (studying) return;
    if (processing.size > 0) return;

    // Don't study if there are tasks needing action
    const hasUrgent = [...state.activeTasks.values()].some(
      (t) => t.status === "requested" || t.status === "revision" || t.status === "accepted",
    );
    if (hasUrgent) return;

    if (Date.now() - state.lastStudyTime < config.studyIntervalMs) return;

    studying = true;
    emit({ type: "study", message: "Starting study session..." });
    appendLog("Study session started");

    try {
      const result = await runStudySession(llm, config);
      state.lastStudyTime = Date.now();
      state.totalStudySessions++;

      emit({
        type: "study",
        message: `Study complete: ${result.topic} (${result.tokensUsed} tokens)`,
      });
      appendLog(`Study session complete: ${result.topic} — ${result.insight.slice(0, 100)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit({ type: "error", message: `Study error: ${msg}` });
      appendLog(`Study error: ${msg}`);
      // Avoid retrying immediately on failure
      state.lastStudyTime = Date.now();
    } finally {
      studying = false;
    }
  }

  function start() {
    if (state.running) return;
    state.running = true;
    state.startedAt = Date.now();
    // Don't study immediately on restart — wait one full interval
    if (state.lastStudyTime === 0) {
      state.lastStudyTime = Date.now();
    }
    appendLog("Heartbeat started");
    connectWs();
    void tick();
  }

  function stop() {
    state.running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    disconnectWs();
    appendLog("Heartbeat stopped");
  }

  return { state, start, stop, onEvent };
}

export type Heartbeat = ReturnType<typeof createHeartbeat>;
