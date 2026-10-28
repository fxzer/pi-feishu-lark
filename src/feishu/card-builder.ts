/** 单卡 UI 纯函数：构建飞书 interactive / CardKit 卡片 JSON（无 IO） */
import { execFileSync } from "node:child_process";

export type ReplyCardStatus = "running" | "done" | "failed" | "stopped" | "inactive";

export type ToolStep = {
  id: string;
  name: string;
  summary: string;
  status: "running" | "done" | "error";
  startTime: number;
  durationMs?: number;
};

export const STOP_ACTION = "pi_feishu_stop_task";
export const QUICK_PROMPT_ACTION = "pi_feishu_quick_prompt";
const MAX_NOTE_CHARS = 96;
export const WAITING_TEXT = "正在回复…";

export function parseQuickPromptActionValue(value: unknown): { key: string; prompt: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== QUICK_PROMPT_ACTION) return undefined;
  if (typeof raw.key !== "string" || !raw.key) return undefined;
  if (typeof raw.prompt !== "string" || !raw.prompt) return undefined;
  return { key: raw.key, prompt: raw.prompt };
}

export function getGitDiffSummary(cwd?: string): { summary?: string; count: number } {
  if (!cwd) return { count: 0 };
  try {
    const raw = execFileSync("git", ["status", "--short"], {
      cwd,
      timeout: 2000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!raw) return { count: 0 };

    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return { count: 0 };

    const maxFiles = 6;
    const displayLines = lines.slice(0, maxFiles);
    const formatted = displayLines.map((line) => `> - \`${line}\``);
    if (lines.length > maxFiles) {
      formatted.push(`> ... 其余 ${lines.length - maxFiles} 个改动文件已折叠`);
    }

    const summary = `> **代码变更** (共 ${lines.length} 个文件)\n${formatted.join("\n")}`;
    return { summary, count: lines.length };
  } catch {
    return { count: 0 };
  }
}

export function buildQuickActionButtons(key: string, hasGitChanges = false, copySourceId?: string): object[] {
  const buttons: object[] = [];
  if (copySourceId) {
    buttons.push({
      tag: "button",
      type: "default",
      size: "small",
      text: { tag: "plain_text", content: "复制原文" },
      value: { action: "pi_feishu_copy_markdown", copySourceId },
      behaviors: [
        {
          type: "callback",
          value: { action: "pi_feishu_copy_markdown", copySourceId },
        },
      ],
    });
  }
  return buttons;
}

export function formatToolSummary(name: string, args: any): string {
  if (!args || typeof args !== "object") return name;
  let target = "";
  if (typeof args.command === "string") {
    target = args.command.trim().replace(/\s+/g, " ");
  } else if (typeof args.path === "string") {
    target = args.path;
  } else if (typeof args.file_path === "string") {
    target = args.file_path;
  } else if (typeof args.query === "string") {
    target = args.query;
  } else if (typeof args.pattern === "string") {
    target = args.pattern;
  } else {
    const keys = Object.keys(args);
    if (keys.length > 0 && typeof args[keys[0]] === "string") {
      target = String(args[keys[0]]).trim();
    }
  }
  if (target.length > 60) {
    target = target.slice(0, 57) + "…";
  }
  return target ? `${name}: ${target}` : name;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatToolStepsMarkdown(steps: ToolStep[], _isRunning = true): string {
  if (!steps || steps.length === 0) return "";
  const lines: string[] = [];

  for (const step of steps) {
    // 纯递增流：仅输出已结束/失败的步骤；执行中的步骤不输出，避免状态突变篡改前缀行
    if (step.status === "running") continue;
    const statusLabel = step.status === "error" ? "[失败]" : "[完成]";
    const dur = step.durationMs != null ? ` (${formatDuration(step.durationMs)})` : "";
    lines.push(`> - ${statusLabel} \`${step.summary}\`${dur}`);
  }
  return lines.join("\n");
}

export function formatProgressSection(
  arg1?: string | ToolStep[],
  arg2?: ToolStep[],
  _isRunning = true,
): string {
  const steps = Array.isArray(arg1) ? arg1 : arg2;
  if (!steps || steps.length === 0) return "";
  const stepsMd = formatToolStepsMarkdown(steps);
  if (!stepsMd.trim()) return "";
  // 头部永久固定，剔除 mutable 计步与当前状态，确保历史行永久不变（Append-Only）
  return `> **执行步骤**\n${stepsMd}`;
}

/** CardKit JSON 2.0 停止按钮（直接放在 elements 里，不用 1.0 的 action 模块） */
export function buildStopButton(key: string, runId?: string) {
  return {
    tag: "button",
    type: "danger",
    text: { tag: "plain_text", content: "停止" },
    // 兼容旧 value 回调 + JSON 2.0 behaviors.callback
    value: { action: STOP_ACTION, key, runId },
    behaviors: [
      {
        type: "callback",
        value: { action: STOP_ACTION, key, runId },
      },
    ],
  };
}

/**
 * CardKit schema 2.0 卡片（流式/全量更新共用）。
 * running 必须带停止按钮，避免只有 markdown 无法中止。
 */
export function buildCardKitCardJson(input: {
  status: ReplyCardStatus;
  body?: string;
  key?: string;
  runId?: string;
  note?: string;
  progress?: string;
  hasGitChanges?: boolean;
  copySourceId?: string;
  streaming?: boolean;
  printFrequencyMs?: number;
  printStep?: number;
}) {
  const running = input.status === "running";
  const body = (input.body || "").trim();
  const progress = (input.progress || "").trim();
  const note = input.note ? normalizeNote(input.note) : undefined;
  const elements: object[] = [];

  let fullContent = "";
  if (progress && body) {
    fullContent = `${progress}\n\n---\n\n${body}`;
  } else if (progress) {
    fullContent = progress;
  } else if (body) {
    fullContent = body;
  } else {
    fullContent = running ? WAITING_TEXT : " ";
  }

  if (running) {
    elements.push({
      tag: "markdown",
      content: fullContent,
      element_id: "content",
    });
    if (input.key) {
      elements.push(buildStopButton(input.key, input.runId));
    }
  } else if (input.status === "done") {
    // 方案 1：完成态将步骤与代码变更放入原生折叠面板（默认收起），保证正文极致清爽
    if (progress) {
      const stepCount = (progress.match(/^> - \[(?:完成|失败)\]/gm) || []).length;
      const diffMatch = progress.match(/代码变更 \(共 (\d+) 个文件\)/);
      let titleText = "查看执行步骤与变更";
      if (stepCount > 0 && diffMatch) {
        titleText = `查看执行过程与变更 (${stepCount} 步 / ${diffMatch[1]} 文件)`;
      } else if (stepCount > 0) {
        titleText = `查看执行过程 (共 ${stepCount} 步)`;
      } else if (diffMatch) {
        titleText = `查看代码变更 (共 ${diffMatch[1]} 文件)`;
      }

      elements.push({
        tag: "collapsible_panel",
        expanded: false,
        direction: "vertical",
        vertical_spacing: "4px",
        padding: "4px 8px 4px 8px",
        header: {
          title: {
            tag: "plain_text",
            content: titleText,
          },
          icon: {
            tag: "standard_icon",
            token: "down-round_outlined",
          },
          icon_position: "follow_text",
        },
        border: {
          color: "grey",
          corner_radius: "5px",
        },
        elements: [
          {
            tag: "markdown",
            content: progress,
          },
        ],
      });
    }

    elements.push({
      tag: "markdown",
      content: body || " ",
      element_id: "content",
    });
    if (input.key) {
      const buttons = buildQuickActionButtons(input.key, Boolean(input.hasGitChanges), input.copySourceId);
      if (buttons.length > 0) {
        elements.push({
          tag: "column_set",
          flex_mode: "none",
          horizontal_spacing: "small",
          columns: buttons.map((btn) => ({
            tag: "column",
            width: "auto",
            elements: [btn],
          })),
        });
      }
    }
  } else {
    const parts: string[] = [];
    if (fullContent && fullContent !== " ") parts.push(fullContent);
    if (note) parts.push(`*(${note})*`);
    elements.push({
      tag: "markdown",
      content: parts.join("\n\n") || " ",
      element_id: "content",
    });
  }

  const config: Record<string, unknown> = {
    wide_screen_mode: true,
    update_multi: true,
    streaming_mode: Boolean(input.streaming && running),
  };
  if (input.streaming && running) {
    config.streaming_config = {
      print_frequency_ms: { default: input.printFrequencyMs ?? 50 },
      print_step: { default: input.printStep ?? 1 },
    };
  }

  return {
    schema: "2.0",
    config,
    header: {
      template: headerTemplate(input.status),
      title: { tag: "plain_text", content: titleForStatus(input.status) },
    },
    body: { elements },
  };
}

export function parseStopTaskActionValue(value: unknown): { key: string; runId?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== STOP_ACTION || typeof raw.key !== "string") return undefined;
  return {
    key: raw.key,
    runId: typeof raw.runId === "string" ? raw.runId : undefined,
  };
}

function normalizeNote(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_NOTE_CHARS) return compact;
  return `${compact.slice(0, MAX_NOTE_CHARS - 1)}…`;
}

function titleForStatus(status: ReplyCardStatus) {
  if (status === "done") return "回复";
  if (status === "failed") return "出错了";
  if (status === "stopped") return "已停止";
  if (status === "inactive") return "已结束";
  return "回复中";
}

function headerTemplate(status: ReplyCardStatus) {
  if (status === "done") return "green";
  if (status === "failed") return "red";
  if (status === "stopped") return "grey";
  if (status === "inactive") return "grey";
  return "blue";
}

export function defaultFinalNote(status: Exclude<ReplyCardStatus, "running" | "inactive">): string | undefined {
  if (status === "done") return undefined;
  if (status === "failed") return "处理失败";
  return "已停止";
}
