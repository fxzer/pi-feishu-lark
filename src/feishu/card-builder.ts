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
const WAITING_TEXT = "正在回复…";

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
  if (hasGitChanges) {
    buttons.push({
      tag: "button",
      type: "primary",
      size: "small",
      text: { tag: "plain_text", content: "查看完整 Diff" },
      value: { action: QUICK_PROMPT_ACTION, key, prompt: "查看当前工作区 git diff 完整变动" },
      behaviors: [
        {
          type: "callback",
          value: { action: QUICK_PROMPT_ACTION, key, prompt: "查看当前工作区 git diff 完整变动" },
        },
      ],
    });
  }
  buttons.push({
    tag: "button",
    type: "default",
    size: "small",
    text: { tag: "plain_text", content: "运行项目测试" },
    value: { action: QUICK_PROMPT_ACTION, key, prompt: "运行项目测试并汇报结果" },
    behaviors: [
      {
        type: "callback",
        value: { action: QUICK_PROMPT_ACTION, key, prompt: "运行项目测试并汇报结果" },
      },
    ],
  });
  buttons.push({
    tag: "button",
    type: "default",
    size: "small",
    text: { tag: "plain_text", content: "查看状态" },
    value: { action: QUICK_PROMPT_ACTION, key, prompt: "/status" },
    behaviors: [
      {
        type: "callback",
        value: { action: QUICK_PROMPT_ACTION, key, prompt: "/status" },
      },
    ],
  });
  return buttons;
}

export function buildReplyCardQuickActionButtons(key: string, hasGitChanges = false, copySourceId?: string): object[] {
  const actions: object[] = [];
  if (copySourceId) {
    actions.push({
      tag: "button",
      type: "default",
      size: "small",
      text: { tag: "plain_text", content: "复制原文" },
      value: { action: "pi_feishu_copy_markdown", copySourceId },
    });
  }
  if (hasGitChanges) {
    actions.push({
      tag: "button",
      type: "primary",
      size: "small",
      text: { tag: "plain_text", content: "查看完整 Diff" },
      value: { action: QUICK_PROMPT_ACTION, key, prompt: "查看当前工作区 git diff 完整变动" },
    });
  }
  actions.push({
    tag: "button",
    type: "default",
    size: "small",
    text: { tag: "plain_text", content: "运行项目测试" },
    value: { action: QUICK_PROMPT_ACTION, key, prompt: "运行项目测试并汇报结果" },
  });
  actions.push({
    tag: "button",
    type: "default",
    size: "small",
    text: { tag: "plain_text", content: "查看状态" },
    value: { action: QUICK_PROMPT_ACTION, key, prompt: "/status" },
  });
  return actions;
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

export function formatToolStepsMarkdown(steps: ToolStep[], isRunning = true): string {
  if (!steps || steps.length === 0) return "";
  const lines: string[] = [];
  const total = steps.length;
  const maxDisplay = 5;
  const displaySteps = isRunning && total > maxDisplay
    ? steps.slice(total - maxDisplay)
    : steps;

  if (isRunning && total > maxDisplay) {
    lines.push(`> ... 已收拢前 ${total - maxDisplay} 个步骤`);
  }

  for (const step of displaySteps) {
    const statusLabel = step.status === "running"
      ? "[执行中]"
      : step.status === "error"
        ? "[失败]"
        : "[完成]";
    const dur = step.durationMs != null ? ` (${formatDuration(step.durationMs)})` : "";
    lines.push(`> - ${statusLabel} \`${step.summary}\`${dur}`);
  }
  return lines.join("\n");
}

export function formatProgressSection(currentAction?: string, steps?: ToolStep[], isRunning = true): string {
  const parts: string[] = [];
  if (isRunning && currentAction) {
    parts.push(`**当前状态**：${currentAction}`);
  }
  if (steps && steps.length > 0) {
    const header = isRunning
      ? `> **执行步骤** (共 ${steps.length} 步)`
      : `> **执行过程** (共 ${steps.length} 步)`;
    const stepsMd = formatToolStepsMarkdown(steps, isRunning);
    parts.push(`${header}\n${stepsMd}`);
  }
  return parts.join("\n\n");
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
  if (running) {
    if (progress && body) {
      fullContent = `${progress}\n\n---\n\n${body}`;
    } else if (progress) {
      fullContent = progress;
    } else {
      fullContent = body || WAITING_TEXT;
    }
    elements.push({
      tag: "markdown",
      content: fullContent,
      element_id: "content",
    });
    if (input.key) {
      elements.push(buildStopButton(input.key, input.runId));
    }
  } else if (input.status === "done") {
    if (progress && body) {
      fullContent = `${progress}\n\n---\n\n${body}`;
    } else if (progress) {
      fullContent = progress;
    } else {
      fullContent = body || " ";
    }
    elements.push({
      tag: "markdown",
      content: fullContent,
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
    if (note) parts.push(note);
    if (progress) parts.push(progress);
    if (body) parts.push(body);
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

/**
 * 普通 interactive 消息卡片（非 CardKit 实体）：
 * - running: 标题「回复中」+ 正文 + [停止]
 * - done: 标题「回复」+ 最终正文
 * - stopped/failed: 标题 + 说明
 */
export function buildReplyCard(input: {
  key: string;
  status: ReplyCardStatus;
  note?: string;
  body?: string;
  progress?: string;
  hasGitChanges?: boolean;
  copySourceId?: string;
  runId?: string;
}) {
  const running = input.status === "running";
  const body = (input.body || "").trim();
  const progress = (input.progress || "").trim();
  const note = input.note ? normalizeNote(input.note) : undefined;
  const elements: object[] = [];

  if (running) {
    if (progress) {
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: progress },
      });
    }
    if (body) {
      if (progress) elements.push({ tag: "hr" });
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: body },
      });
    } else if (!progress) {
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: WAITING_TEXT },
      });
    }
    // 1.0 interactive 仍可用 action 模块；同时附带 2.0 button 以兼容
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "停止" },
          type: "danger",
          value: { action: STOP_ACTION, key: input.key, runId: input.runId },
        },
      ],
    });
  } else if (input.status === "done") {
    if (progress) {
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: progress },
      });
      if (body) elements.push({ tag: "hr" });
    }
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: body || " " },
    });
    if (input.key) {
      elements.push({
        tag: "action",
        actions: buildReplyCardQuickActionButtons(input.key, Boolean(input.hasGitChanges), input.copySourceId),
      });
    }
  } else {
    if (note) {
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: note },
      });
    }
    if (progress) {
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: progress },
      });
    }
    if (body) {
      if (elements.length) elements.push({ tag: "hr" });
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: body },
      });
    }
    if (!elements.length) {
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: " " },
      });
    }
  }

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: headerTemplate(input.status),
      title: { tag: "plain_text", content: titleForStatus(input.status) },
    },
    elements,
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
