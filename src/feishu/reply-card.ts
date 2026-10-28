/**
 * 回复呈现：
 * - 默认 CardKit streaming_mode：客户端逐字打印（print_step=1）
 * - 关闭流式时：先「回复中」卡，结束一次写入全文
 * - 不展示工具/阶段过程
 */
import { randomUUID } from "node:crypto";
import {
  buildReplyCard,
  defaultFinalNote,
  formatProgressSection,
  formatToolSummary,
  getGitDiffSummary,
  type ReplyCardStatus,
  type ToolStep,
} from "./card-builder.ts";
import { CardKitStream } from "./cardkit-stream.ts";
import { loadConfig, runtimeEnv } from "./config.ts";
import { debugLog } from "./debug.ts";

export type { ReplyCardStatus } from "./card-builder.ts";
export {
  buildReplyCard,
  parseStopTaskActionValue,
  STOP_ACTION,
} from "./card-builder.ts";

export type ReplyCardSink = {
  readonly runId: string;
  readonly bodyText: string;
  updateFromEvent(event: unknown): void;
  stopImmediately(note?: string): Promise<void>;
  finish(status: Exclude<ReplyCardStatus, "running" | "inactive">, note?: string): Promise<void>;
  append(delta: string): void;
  ensureFinal(text: string): void;
};

export type ReplyCardStreamOptions = {
  enabled?: boolean;
  /** CardKit 客户端打印间隔 ms（默认 50） */
  printFrequencyMs?: number;
  /** CardKit 每次打印字符数（默认 1） */
  printStep?: number;
  /** 服务端推送 fullText 到 CardKit 的间隔 ms（默认 120） */
  pushIntervalMs?: number;
};

type ReplyCardTransport = {
  replyCard(messageId: string, card: object): Promise<string | undefined>;
  updateCard(messageId: string, card: object): Promise<void>;
  replyPlainText?(messageId: string, text: string): Promise<string | undefined>;
  updateText?(messageId: string, text: string): Promise<void>;
  /** 记录本 bot 出站消息，供 groupAlsoOnReply */
  rememberOutboundMessageId?(messageId: string): void;
  rememberMarkdownCopySource?(copySourceId: string, markdown: string): void;
};

function resolveStreamOptions(override?: ReplyCardStreamOptions) {
  const cfg = loadConfig();
  return {
    enabled: override?.enabled ?? cfg?.streamingReply !== false,
    printFrequencyMs: Math.max(
      20,
      override?.printFrequencyMs
        ?? parseEnvInt("FEISHU_STREAM_PRINT_FREQUENCY_MS")
        ?? cfg?.streamPrintFrequencyMs
        ?? 50,
    ),
    printStep: Math.max(
      1,
      override?.printStep
        ?? parseEnvInt("FEISHU_STREAM_PRINT_STEP")
        ?? cfg?.streamPrintStep
        ?? 1,
    ),
    pushIntervalMs: Math.max(
      50,
      override?.pushIntervalMs
        ?? parseEnvInt("FEISHU_STREAM_PUSH_INTERVAL_MS")
        ?? cfg?.streamPushIntervalMs
        ?? 120,
    ),
  };
}

function parseEnvInt(name: string): number | undefined {
  const v = runtimeEnv(name)?.trim();
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

export class ReplyCard implements ReplyCardSink {
  readonly runId = randomUUID();
  private status: ReplyCardStatus = "running";
  private body = "";
  private note: string | undefined;
  get bodyText() { return this.body; }
  private cardkit: CardKitStream | undefined;
  private fallbackCardId: string | undefined;
  private readonly streamOpts: ReturnType<typeof resolveStreamOptions>;
  private readonly key: string;
  private readonly replyToMessageId: string;
  private readonly transport: ReplyCardTransport;
  private readonly workspace?: string;
  private tools: ToolStep[] = [];
  private currentAction = "正在思考…";
  private lastProgressPush = 0;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly throttleMs = 1500;

  constructor(
    key: string,
    replyToMessageId: string,
    transport: ReplyCardTransport,
    streamOptions?: ReplyCardStreamOptions,
    workspace?: string,
  ) {
    this.key = key;
    this.replyToMessageId = replyToMessageId;
    this.transport = transport;
    this.streamOpts = resolveStreamOptions(streamOptions);
    this.workspace = workspace;
  }

  get messageId() {
    return this.fallbackCardId;
  }

  async start() {
    const cfg = loadConfig();
    const initialProgress = formatProgressSection(this.tools);

    if (this.streamOpts.enabled && cfg?.appId && cfg?.appSecret) {
      this.cardkit = new CardKitStream(
        cfg.appId,
        cfg.appSecret,
        cfg.domain === "lark" ? "lark" : "feishu",
        this.replyToMessageId,
        async (text) => {
          // CardKit 失败：回落为普通最终卡片
          if (text.trim()) {
            this.transport.rememberMarkdownCopySource?.(this.runId, text);
          }
          const id = await this.transport.replyCard(
            this.replyToMessageId,
            buildReplyCard({
              key: this.key,
              runId: this.runId,
              status: "done",
              progress: this.tools.length > 0 ? formatProgressSection(this.tools) : undefined,
              copySourceId: this.runId,
              body: text,
            }),
          );
          this.fallbackCardId = id;
        },
        {
          printFrequencyMs: this.streamOpts.printFrequencyMs,
          printStep: this.streamOpts.printStep,
          pushIntervalMs: this.streamOpts.pushIntervalMs,
          conversationKey: this.key,
          runId: this.runId,
          onOutboundMessageId: (id) => this.transport.rememberOutboundMessageId?.(id),
        },
      );
      this.cardkit.setProgress(initialProgress);
      debugLog("feishu.reply_card.cardkit_ready", {
        key: this.key,
        runId: this.runId,
        ...this.streamOpts,
      });
      // 先让飞书看到「回复中」，不等待 Pi 产出第一段正文；失败仍会在结束时回落为普通回复卡。
      void this.cardkit.startImmediately();
      return;
    }

    // 非流式：先出「回复中」占位卡
    this.fallbackCardId = await this.transport.replyCard(
      this.replyToMessageId,
      buildReplyCard({
        key: this.key,
        runId: this.runId,
        status: "running",
        progress: initialProgress,
        body: "",
      }),
    );
    debugLog("feishu.reply_card.started_static", {
      key: this.key,
      runId: this.runId,
      cardMessageId: this.fallbackCardId,
    });
  }

  updateFromEvent(event: unknown) {
    if (!event || typeof event !== "object" || this.status !== "running") return;
    const ev = event as Record<string, any>;

    if (ev.type === "tool_execution_start") {
      const toolCallId = String(ev.toolCallId || randomUUID());
      const toolName = String(ev.toolName || "tool");
      const summary = formatToolSummary(toolName, ev.args);
      const existing = this.tools.find((t) => t.id === toolCallId);
      if (!existing) {
        this.tools.push({
          id: toolCallId,
          name: toolName,
          summary,
          status: "running",
          startTime: Date.now(),
        });
      }
      this.currentAction = `正在执行 \`${summary}\``;
      this.scheduleProgressUpdate();
      return;
    }

    if (ev.type === "tool_execution_end") {
      const toolCallId = ev.toolCallId ? String(ev.toolCallId) : "";
      const toolName = String(ev.toolName || "tool");
      const isError = Boolean(ev.isError);

      let step = toolCallId ? this.tools.find((t) => t.id === toolCallId) : undefined;
      if (!step) {
        step = [...this.tools].reverse().find((t) => t.name === toolName && t.status === "running");
      }

      if (step) {
        step.status = isError ? "error" : "done";
        step.durationMs = Math.max(1, Date.now() - step.startTime);
        this.currentAction = isError ? `执行失败: \`${step.name}\`` : `已完成: \`${step.name}\``;
      } else {
        this.currentAction = isError ? `工具执行失败` : `工具执行完成`;
      }
      this.scheduleProgressUpdate();
      return;
    }

    if (ev.type === "message_update") {
      const ame = ev.assistantMessageEvent;
      if (ame?.type === "thinking_delta") {
        const hasRunningTool = this.tools.some((t) => t.status === "running");
        if (!hasRunningTool && this.currentAction !== "正在思考…") {
          this.currentAction = "正在思考…";
          this.scheduleProgressUpdate();
        }
      } else if (ame?.type === "text_delta") {
        const hasRunningTool = this.tools.some((t) => t.status === "running");
        if (!hasRunningTool && this.currentAction !== "正在生成回复…") {
          this.currentAction = "正在生成回复…";
          this.scheduleProgressUpdate();
        }
      }
      return;
    }
  }

  private scheduleProgressUpdate() {
    if (this.status !== "running") return;
    const now = Date.now();
    const elapsed = now - this.lastProgressPush;

    if (elapsed >= this.throttleMs) {
      if (this.progressTimer) {
        clearTimeout(this.progressTimer);
        this.progressTimer = null;
      }
      this.lastProgressPush = now;
      void this.flushProgress();
    } else if (!this.progressTimer) {
      const delay = Math.max(50, this.throttleMs - elapsed);
      this.progressTimer = setTimeout(() => {
        this.progressTimer = null;
        if (this.status !== "running") return;
        this.lastProgressPush = Date.now();
        void this.flushProgress();
      }, delay);
    }
  }

  private async flushProgress() {
    const progress = formatProgressSection(this.tools);
    if (this.cardkit) {
      this.cardkit.setProgress(progress);
      return;
    }
    if (this.fallbackCardId) {
      try {
        await this.transport.updateCard(
          this.fallbackCardId,
          buildReplyCard({
            key: this.key,
            runId: this.runId,
            status: "running",
            progress,
            body: this.body,
          }),
        );
      } catch (e) {
        debugLog("feishu.reply_card.update_error", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  append(delta: string) {
    if (this.status !== "running" || !delta) return;
    this.body += delta;
    if (this.currentAction !== "正在生成回复…") {
      this.currentAction = "正在生成回复…";
    }
    this.cardkit?.append(delta);
  }

  ensureFinal(text: string) {
    if (!text) return;
    if (!this.body.trim() || text.length >= this.body.length) this.body = text;
    this.cardkit?.ensureFinal(text);
  }

  async stopImmediately(note = "已停止") {
    await this.finishFinal("stopped", note);
  }

  async finish(status: Exclude<ReplyCardStatus, "running" | "inactive">, note?: string) {
    await this.finishFinal(status, note);
  }

  async completeWithAnswer(answer: string) {
    this.ensureFinal(answer || "（无内容）");
    await this.finishFinal("done", undefined);
  }

  private async finishFinal(
    status: Exclude<ReplyCardStatus, "running" | "inactive">,
    note: string | undefined,
  ) {
    if (this.status !== "running") return;
    this.status = status;
    this.note = note ?? defaultFinalNote(status);

    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }

    // 最终总结：有工具步骤时展示执行过程；有代码变更时附加代码变更面板
    const progressParts: string[] = [];
    if (this.tools.length > 0) {
      const toolSec = formatProgressSection(this.tools);
      if (toolSec) progressParts.push(toolSec);
    }
    const gitDiff = status === "done" ? getGitDiffSummary(this.workspace) : { count: 0 };
    if (gitDiff.summary) {
      progressParts.push(gitDiff.summary);
    }
    const finalProgress = progressParts.join("\n\n");
    const hasGitChanges = gitDiff.count > 0;
    const copySourceId = status === "done" ? this.runId : undefined;
    if (copySourceId && this.body.trim()) {
      this.transport.rememberMarkdownCopySource?.(copySourceId, this.body);
    }

    if (this.cardkit) {
      this.cardkit.setProgress(finalProgress);
      // 同一张 CardKit 卡上关闭流式并更新 header（回复/已停止/出错了），并附带快捷操作栏
      await this.cardkit.close(
        this.body,
        status === "failed" ? "failed" : status === "stopped" ? "stopped" : "done",
        hasGitChanges,
        copySourceId,
      );
      return;
    }

    // 静态卡路径
    if (this.fallbackCardId) {
      try {
        await this.transport.updateCard(
          this.fallbackCardId,
          buildReplyCard({
            key: this.key,
            runId: this.runId,
            status,
            note: status === "done" ? undefined : this.note,
            progress: finalProgress,
            hasGitChanges,
            copySourceId,
            body: this.body,
          }),
        );
      } catch (error) {
        debugLog("feishu.reply_card.static_final_error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
