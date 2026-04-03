import { spawnSync } from "child_process";
import WebSocket from "ws";
import type { CashClawConfig } from "./config.js";
import type { LLMProvider } from "./llm/types.js";
import { createClaudeCliProvider } from "./llm/claude-cli.js";
import type { Task } from "./moltlaunch/types.js";
import * as cli from "./moltlaunch/cli.js";
import { createHyrveClientFromEnv, type HyrveClient } from "./hyrve/client.js";
import type { HyrveOrder } from "./hyrve/types.js";
import { runAgentLoop, type LoopResult } from "./loop/index.js";
import { runStudySession } from "./loop/study.js";
import { storeFeedback } from "./memory/feedback.js";
import { appendLog } from "./memory/log.js";

// Use lightweight Haiku model for study sessions to reduce cost and latency
const STUDY_MODEL = "claude-haiku-4-5-20251001";

// 8 hours between periodic X posts
const X_POST_INTERVAL_MS = 8 * 60 * 60 * 1000;

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
  lastXPostTime: number;
}

export interface ActivityEvent {
  timestamp: number;
  type: "poll" | "loop_start" | "loop_complete" | "tool_call" | "feedback" | "error" | "ws" | "study" | "xpost";
  taskId?: string;
  message: string;
}

type EventListener = (event: ActivityEvent) => void;

const TERMINAL_STATUSES = new Set([
  "completed", "declined", "cancelled", "expired", "resolved", "disputed",
]);

const WS_URL = "wss://api.moltlaunch.com/ws";
const WS_INITIAL_RECONNECT_MS = 5_000;
const WS_MAX_RECONNECT_MS = 300_000; // 5 min cap
// When WS is connected, poll as a sync check (60s to catch tasks WS might miss)
const WS_POLL_INTERVAL_MS = 60_000;
// Keepalive ping to prevent proxy/server idle timeout
const WS_PING_INTERVAL_MS = 20_000;
// If no pong within this window after a ping, assume connection is dead
const WS_PONG_TIMEOUT_MS = 10_000;
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
    lastXPostTime: 0,
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let ws: WebSocket | null = null;
  let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let wsPingTimer: ReturnType<typeof setInterval> | null = null;
  let wsPongTimer: ReturnType<typeof setTimeout> | null = null;
  let wsReconnectDelay = WS_INITIAL_RECONNECT_MS;
  let wsFailLogged = false;
  const processing = new Set<string>();

  // --- HYRVE AI marketplace client (optional second marketplace) ---
  const hyrveClient: HyrveClient | null = createHyrveClientFromEnv();
  const hyrveProcessing = new Set<string>(); // orderId
  const hyrveProcessed = new Set<string>(); // delivered/completed order IDs

  /** Convert a HYRVE order to a Task-compatible object for the agent loop */
  function hyrveOrderToTask(order: HyrveOrder, jobDescription: string): Task {
    const statusMap: Record<string, Task["status"]> = {
      pending: "requested",
      active: "accepted",
      delivered: "submitted",
      completed: "completed",
      disputed: "disputed",
      cancelled: "cancelled",
      refunded: "expired",
    };
    return {
      id: `hyrve:${order.id}`,
      agentId: order.agentId,
      clientAddress: order.clientId,
      task: jobDescription,
      status: statusMap[order.status] ?? "requested",
      acceptedAt: order.createdAt ? new Date(order.createdAt).getTime() : undefined,
      submittedAt: order.deliveredAt ? new Date(order.deliveredAt).getTime() : undefined,
      completedAt: order.completedAt ? new Date(order.completedAt).getTime() : undefined,
    };
  }
  const completedTasks = new Set<string>();
  // Track task+status combos to prevent duplicate processing from WS+poll overlap
  const processedVersions = new Map<string, string>();
  const listeners: EventListener[] = [];

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

  function stopWsTimers() {
    if (wsPingTimer) {
      clearInterval(wsPingTimer);
      wsPingTimer = null;
    }
    if (wsPongTimer) {
      clearTimeout(wsPongTimer);
      wsPongTimer = null;
    }
  }

  function connectWs() {
    if (!state.running || !config.agentId) return;

    // Clean up the old WebSocket before creating a new one to prevent stale listeners
    if (ws) {
      ws.removeAllListeners();
      ws.terminate();
      ws = null;
    }
    stopWsTimers();

    try {
      ws = new WebSocket(`${WS_URL}/${config.agentId}`);

      ws.on("open", () => {
        state.wsConnected = true;
        wsReconnectDelay = WS_INITIAL_RECONNECT_MS;
        wsFailLogged = false;
        emit({ type: "ws", message: "WebSocket connected" });
        appendLog("WebSocket connected");

        // Keepalive: periodic pings + pong timeout to detect dead connections
        wsPingTimer = setInterval(() => {
          if (ws?.readyState !== WebSocket.OPEN) return;
          wsPongTimer = setTimeout(() => {
            // No pong received — connection is dead, force reconnect
            emit({ type: "ws", message: "WebSocket pong timeout — forcing reconnect" });
            appendLog("WebSocket pong timeout — forcing reconnect");
            ws?.terminate();
          }, WS_PONG_TIMEOUT_MS);
          ws.ping();
        }, WS_PING_INTERVAL_MS);

        ws?.on("pong", () => {
          if (wsPongTimer) {
            clearTimeout(wsPongTimer);
            wsPongTimer = null;
          }
        });
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
        stopWsTimers();
        // Only log the first disconnect, suppress repeated failures
        if (!wsFailLogged) {
          emit({ type: "ws", message: "WebSocket disconnected — retrying in background" });
          wsFailLogged = true;
        }
        scheduleWsReconnect();
        // Immediately poll to catch any tasks that arrived while WS was up
        // (WS_POLL_INTERVAL_MS is 60s — a disconnect means we may have missed tasks)
        if (state.running) {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          void tick();
        }
      });

      ws.on("error", (err: Error) => {
        state.wsConnected = false;
        if (!wsFailLogged) {
          emit({ type: "error", message: `WebSocket error: ${err.message}` });
          wsFailLogged = true;
        }
        // Do NOT call scheduleWsReconnect here — ws.close() will trigger the "close"
        // event which handles reconnect. Calling it here causes double backoff.
        ws?.close();
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
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
    stopWsTimers();
    if (ws) {
      ws.removeAllListeners();
      ws.terminate();
      ws = null;
    }
    state.wsConnected = false;
  }

  // --- Task handling (shared by WS + poll) ---

  function handleTaskEvent(task: Task) {
    if (TERMINAL_STATUSES.has(task.status)) {
      if (task.status === "completed" && task.ratedScore !== undefined) {
        handleCompleted(task);
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

    // Code-level declineKeywords check — hard enforcement before LLM ever sees the task.
    if (config.declineKeywords.length > 0) {
      const taskContent = [task.task, ...(task.messages?.map((m) => m.content) ?? [])].join(" ").toLowerCase();
      const matched = config.declineKeywords.find((kw) => taskContent.includes(kw.toLowerCase()));
      if (matched !== undefined) {
        emit({ type: "loop_start", taskId: task.id, message: `Task declined (prohibited keyword: "${matched}")` });
        appendLog(`Task ${task.id} auto-declined: prohibited keyword "${matched}"`);
        cli.declineTask(task.id, "Task declined: prohibited content detected").catch(() => {});
        processing.delete(task.id);
        return;
      }
    }

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

    // Check and auto-claim open bounties on every poll
    void checkBounties();

    // Also poll HYRVE AI marketplace if configured
    if (hyrveClient !== null) {
      void tickHyrve();
    }

    scheduleNext();
  }

  /** HYRVE ハートビート送信 + クライアントからのオーダーを処理する */
  async function tickHyrve() {
    if (hyrveClient === null) return;
    try {
      // ハートビート送信（オンライン維持）
      try {
        const hb = await hyrveClient.sendHeartbeat();
        if (hb.pending_jobs > 0) {
          emit({ type: "poll", message: `[HYRVE] Heartbeat OK, pending_jobs=${hb.pending_jobs}` });
          appendLog(`[HYRVE] Heartbeat: ${hb.pending_jobs} pending job(s)`);
        }
      } catch {
        // ハートビート失敗は無視して続行
      }

      // オープンな仕事を定期チェックしてログに残す（発注者が来たときに即気づけるよう）
      try {
        const availableJobs = await hyrveClient.listAvailableJobs();
        if (availableJobs.length > 0) {
          const jobSummary = availableJobs
            .map((j) => `"${j.title}" ($${j.budget})`)
            .join(", ");
          emit({ type: "poll", message: `[HYRVE] ${availableJobs.length} open job(s): ${jobSummary}` });
          appendLog(`[HYRVE] Open jobs: ${jobSummary}`);
        }
      } catch {
        // ジョブ一覧取得失敗は無視
      }

      // pending（クライアントが発注済み・エージェント未着手）と active（作業中）を処理する
      // ※ Hyrve の実際のステータスは pending/active/delivered/completed で escrow は存在しない
      const pendingOrders = await hyrveClient.listOrders("pending").catch(() => [] as HyrveOrder[]);
      const activeOrders = await hyrveClient.listOrders("active").catch(() => [] as HyrveOrder[]);
      const orders = [...pendingOrders, ...activeOrders];
      for (const order of orders) {
        const key = `hyrve:${order.id}`;
        if (hyrveProcessing.has(key) || hyrveProcessed.has(key)) continue;
        if (processing.size + hyrveProcessing.size >= config.maxConcurrentTasks) break;

        // Find the job description (best-effort)
        let jobDesc = order.description;
        try {
          const job = await hyrveClient.getJob(order.jobId);
          jobDesc = `${job.title}\n\n${job.description}`;
        } catch {
          // Use order.description as fallback
        }

        const task = hyrveOrderToTask(order, jobDesc);
        hyrveProcessing.add(key);
        emit({ type: "loop_start", taskId: key, message: `[HYRVE] Agent loop started for order ${order.id}` });
        appendLog(`[HYRVE] Agent loop started for order ${order.id}`);

        runAgentLoop(llm, task, config)
          .then(async (result: LoopResult) => {
            emit({ type: "loop_complete", taskId: key, message: `[HYRVE] Loop done in ${result.turns} turn(s)` });
            appendLog(`[HYRVE] Loop done for order ${order.id}: ${result.turns} turns`);

            // Deliver the work result
            const deliverable = result.toolCalls
              .filter((tc) => tc.success)
              .map((tc) => `${tc.name}: ${tc.result}`)
              .join("\n") || result.reasoning;

            try {
              await hyrveClient!.deliverJob(order.id, deliverable.slice(0, 10_000));
              hyrveProcessed.add(key);
              emit({ type: "loop_complete", taskId: key, message: `[HYRVE] Delivered order ${order.id}` });
              appendLog(`[HYRVE] Delivered order ${order.id}`);
            } catch (deliverErr) {
              const msg = deliverErr instanceof Error ? deliverErr.message : String(deliverErr);
              emit({ type: "error", taskId: key, message: `[HYRVE] Delivery failed: ${msg}` });
              appendLog(`[HYRVE] Delivery failed for order ${order.id}: ${msg}`);
            }
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            emit({ type: "error", taskId: key, message: `[HYRVE] Loop error: ${msg}` });
            appendLog(`[HYRVE] Loop error for order ${order.id}: ${msg}`);
          })
          .finally(() => {
            hyrveProcessing.delete(key);
          });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit({ type: "error", message: `[HYRVE] Poll error: ${msg}` });
      appendLog(`[HYRVE] Poll error: ${msg}`);
    }
  }

  async function checkBounties() {
    try {
      const bounties = await cli.getBounties();
      for (const bounty of bounties) {
        try {
          await cli.claimBounty(bounty.id, "I can complete this task.");
          emit({ type: "poll", message: `Bounty claimed: ${bounty.id}` });
          appendLog(`Bounty claimed: ${bounty.id}`);
        } catch {
          // Ignore claim failures (already claimed, etc.)
        }
      }
    } catch {
      // Bounty check is best-effort — don't let it affect the main poll loop
    }
  }

  function handleCompleted(task: Task) {
    if (task.ratedScore === undefined) return;
    if (completedTasks.has(task.id)) return;
    completedTasks.add(task.id);

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
      message: `Completed — rated ${task.ratedScore}/5`,
    });
    appendLog(`Task ${task.id} completed — score ${task.ratedScore}/5`);

    // Trigger a proof-of-work X post when a task is completed with a good rating
    if (task.ratedScore >= 4) {
      triggerXPost(true);
    }
  }

  function triggerXPost(force = false) {
    const snsPath = process.env["SNS_AUTOMATION_PATH"];
    const personaId = process.env["X_PERSONA_ID"];
    if (snsPath === undefined || snsPath === "" || personaId === undefined || personaId === "") return;

    const args = ["run", "x:post", "--persona", personaId];
    if (force) args.push("--force");

    emit({ type: "xpost", message: `Triggering X post${force ? " (force)" : ""}` });
    appendLog(`Triggering X post${force ? " (force)" : ""}`);

    const result = spawnSync("bun", args, {
      cwd: snsPath,
      timeout: 120_000,
      env: { ...process.env },
    });

    // Always update lastXPostTime to prevent retry loop on failure
    state.lastXPostTime = Date.now();
    if (result.status !== 0) {
      const stderr = result.stderr?.toString().slice(0, 200) ?? "unknown error";
      emit({ type: "xpost", message: `X post failed: ${stderr}` });
      appendLog(`X post failed: ${stderr}`);
    } else {
      emit({ type: "xpost", message: "X post succeeded" });
      appendLog("X post succeeded");
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

    // Check if we should post to X while idle
    void maybeXPost();

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
  let consecutiveStudyErrors = 0;
  // Backoff: 1min → 2min → 4min → 8min → cap at 30min
  const STUDY_BACKOFF_INTERVALS = [
    60_000, 120_000, 240_000, 480_000, 1_800_000,
  ];

  function getStudyBackoffMs(): number {
    const idx = Math.min(consecutiveStudyErrors, STUDY_BACKOFF_INTERVALS.length - 1);
    return STUDY_BACKOFF_INTERVALS[idx] ?? 60_000;
  }

  async function maybeStudy() {
    if (!config.learningEnabled) return;
    if (studying) return;
    if (processing.size > 0) return;

    // Don't study if there are tasks needing action
    const hasUrgent = [...state.activeTasks.values()].some(
      (t) => t.status === "requested" || t.status === "revision" || t.status === "accepted",
    );
    if (hasUrgent) return;

    const backoffMs = consecutiveStudyErrors > 0 ? getStudyBackoffMs() : config.studyIntervalMs;
    if (Date.now() - state.lastStudyTime < backoffMs) return;

    studying = true;
    emit({ type: "study", message: "Starting study session..." });
    appendLog("Study session started");

    // Use Haiku for study sessions (cheaper, faster, sufficient for learning tasks)
    const studyLlm: LLMProvider = config.llm.provider === "claude-cli"
      ? createClaudeCliProvider(STUDY_MODEL)
      : llm;

    try {
      const result = await runStudySession(studyLlm, config);
      state.lastStudyTime = Date.now();
      state.totalStudySessions++;
      consecutiveStudyErrors = 0; // reset on success

      emit({
        type: "study",
        message: `Study complete: ${result.topic} (${result.tokensUsed} tokens)`,
      });
      appendLog(`Study session complete: ${result.topic} — ${result.insight.slice(0, 100)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      consecutiveStudyErrors++;
      const nextBackoffMs = getStudyBackoffMs();
      emit({ type: "error", message: `Study error (attempt ${consecutiveStudyErrors}): ${msg}` });
      appendLog(`Study error (attempt ${consecutiveStudyErrors}): ${msg}`);
      appendLog(`Auto-repair: next retry in ${nextBackoffMs / 1000}s (backoff)`);
      // Avoid retrying immediately on failure — use exponential backoff
      state.lastStudyTime = Date.now();
    } finally {
      studying = false;
    }
  }

  let xposting = false;

  async function maybeXPost() {
    const snsPath = process.env["SNS_AUTOMATION_PATH"];
    const personaId = process.env["X_PERSONA_ID"];
    if (snsPath === undefined || snsPath === "" || personaId === undefined || personaId === "") return;
    if (xposting) return;
    if (processing.size > 0) return;

    // Don't post if there are tasks needing action
    const hasUrgent = [...state.activeTasks.values()].some(
      (t) => t.status === "requested" || t.status === "revision" || t.status === "accepted",
    );
    if (hasUrgent) return;

    if (Date.now() - state.lastXPostTime < X_POST_INTERVAL_MS) return;

    xposting = true;
    try {
      triggerXPost(false);
    } finally {
      xposting = false;
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
    // Don't post to X immediately on restart — wait one full interval
    if (state.lastXPostTime === 0) {
      state.lastXPostTime = Date.now();
    }
    appendLog("Heartbeat started");
    // 起動時に Hyrve Stripe onboarding 状態を確認
    if (hyrveClient !== null) {
      void checkHyrveOnboarding();
    }
    connectWs();
    void tick();
  }

  async function checkHyrveOnboarding() {
    if (hyrveClient === null) return;
    try {
      const wallet = await hyrveClient.getWallet();
      if (!wallet.stripeOnboardingComplete) {
        const msg = "[HYRVE] WARNING: Stripe onboarding not complete — payments cannot be received. Visit https://app.hyrveai.com to complete onboarding.";
        emit({ type: "error", message: msg });
        appendLog(msg);
      } else {
        appendLog(`[HYRVE] Stripe onboarding complete. Balance: $${wallet.balance} USD`);
      }
    } catch {
      // onboarding check is best-effort
    }
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
