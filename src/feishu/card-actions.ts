/**
 * 飞书交互卡片回调的统一处理（/model、/thinking、/resume、停止按钮、复制按钮）。
 * 只依赖 ConversationRuntime 接口与飞书公共层，各 Runtime 适配器直接复用。
 */
import { spawnSync } from "node:child_process";
import {
  buildCardKitCardJson,
  parseOpenIdeActionValue,
  parseQuickPromptActionValue,
  shortWorkspace,
} from "./card-builder.ts";
import {
  buildModelCard,
  buildResumeCard,
  buildThinkingCard,
  buildWorkspaceCard,
  parseModelActionValue,
  parseResumePageActionValue,
  parseResumeSelectActionValue,
  parseThinkingActionValue,
  parseWorkspaceNavActionValue,
  parseWorkspaceSelectActionValue,
} from "./cards.ts";
import { loadConfig } from "./config.ts";
import { debugLog } from "./debug.ts";
import { parseStopTaskActionValue, ReplyCard } from "./reply-card.ts";
import type { ConversationRuntime } from "./runtime.ts";
import type { FeishuTransport } from "./transport.ts";
import type { FeishuCardAction } from "./types.ts";

export function createCardActionHandler(
  conversations: ConversationRuntime,
  getTransport: () => FeishuTransport | undefined,
) {
  return async (action: FeishuCardAction) => {
    const transport = getTransport();
    const copy = parseCopyMarkdownActionValue(action.value);
    if (copy) {
      const source = transport?.getMarkdownCopySource(copy.copySourceId);
      if (source) {
        copyToSystemClipboard(source);
        return {
          toast: {
            type: "success",
            content: `已复制到剪贴板（共 ${source.length} 字）`,
            i18n: {
              zh_cn: `已复制到剪贴板（共 ${source.length} 字）`,
              en_us: `Copied to clipboard (${source.length} chars)`,
            },
          },
        };
      }
      return {
        toast: {
          type: "warning",
          content: "MD 原文已过期，请重新生成卡片",
          i18n: {
            zh_cn: "MD 原文已过期，请重新生成卡片",
            en_us: "Markdown source expired",
          },
        },
      };
    }

    const openIde = parseOpenIdeActionValue(action.value);
    if (openIde) {
      const ok = openWorkspaceInIde(openIde.workspace);
      const displayWs = shortWorkspace(openIde.workspace);
      if (ok) {
        return {
          toast: {
            type: "success",
            content: `已在 VS Code 中打开: ${displayWs}`,
            i18n: {
              zh_cn: `已在 VS Code 中打开: ${displayWs}`,
              en_us: `Opened in VS Code: ${displayWs}`,
            },
          },
        };
      }
      return {
        toast: {
          type: "warning",
          content: `唤起 VS Code 失败: ${displayWs}`,
          i18n: {
            zh_cn: `唤起 VS Code 失败: ${displayWs}`,
            en_us: `Failed to open VS Code: ${displayWs}`,
          },
        },
      };
    }

    const quickPrompt = parseQuickPromptActionValue(action.value);
    if (quickPrompt) {
      debugLog("feishu.card.quick_prompt_requested", {
        key: quickPrompt.key,
        prompt: quickPrompt.prompt,
        messageId: action.messageId,
      });
      if (transport) {
        const cfg = loadConfig();
        const useStreaming = cfg?.streamingReply !== false;
        const workspace = conversations.getWorkspace(quickPrompt.key);
        const model = await conversations.getSelectedModel(quickPrompt.key);
        const modelName = model ? `${model.provider}/${model.id}` : undefined;
        const replyCard = new ReplyCard(
          quickPrompt.key,
          action.messageId,
          transport,
          {
            enabled: useStreaming,
            printFrequencyMs: cfg?.streamPrintFrequencyMs,
            printStep: cfg?.streamPrintStep,
            pushIntervalMs: cfg?.streamPushIntervalMs,
          },
          workspace,
          modelName,
        );
        await replyCard.start();

        void conversations.promptWithImages(
          quickPrompt.key,
          quickPrompt.prompt,
          [],
          async (reply) => {
            await replyCard.completeWithAnswer(reply || "（无内容）");
          },
          replyCard,
          useStreaming ? (delta) => replyCard.append(delta) : undefined,
        );
      }
      return;
    }

    const stopTask = parseStopTaskActionValue(action.value);
    if (stopTask) {
      debugLog("feishu.card.stop_requested", {
        key: stopTask.key,
        runId: stopTask.runId,
        cardMessageId: action.messageId,
        chatId: action.chatId,
      });
      // 停止时由 ReplyCard.stopImmediately 更新同一张卡；回调不再另发文本
      const result = await conversations.stopConversation(stopTask.key, async () => undefined, stopTask.runId);
      const status = result.status === "stopped"
        ? "stopped"
        : result.status === "failed"
          ? "failed"
          : "inactive";
      debugLog("feishu.card.stop_final_update_done", {
        key: stopTask.key,
        runId: stopTask.runId,
        cardMessageId: action.messageId,
        result: result.status,
      });
      // CardKit 流式卡是 schema 2.0；回调必须返回 2.0，否则会 200830/200671
      // body 优先用 cardkit.close() 已写入的累计文本，避免覆盖已输出内容
      return buildCardKitCardJson({
        status,
        body: "body" in result ? result.body : result.message || "已停止",
        key: stopTask.key,
        runId: stopTask.runId,
        streaming: false,
      });
    }

    const resumePage = parseResumePageActionValue(action.value);
    if (resumePage) {
      const page = await conversations.listResumeSessions(resumePage.key, resumePage.scope, resumePage.page);
      return buildResumeCard(page);
    }

    const wsNav = parseWorkspaceNavActionValue(action.value);
    if (wsNav) {
      const current = conversations.getWorkspace(wsNav.key);
      return buildWorkspaceCard(wsNav.key, current, wsNav.path, wsNav.page);
    }

    const wsSelect = parseWorkspaceSelectActionValue(action.value);
    if (wsSelect) {
      await conversations.switchWorkspace(wsSelect.key, wsSelect.path, async (reply) => {
        await transport?.replyText(action.messageId, reply);
      });
      return buildWorkspaceCard(wsSelect.key, wsSelect.path, wsSelect.path, wsSelect.page);
    }

    const resumeSelect = parseResumeSelectActionValue(action.value);
    if (resumeSelect) {
      await conversations.resumeConversation(resumeSelect.key, resumeSelect.sessionPath, async (reply) => {
        await transport?.replyText(action.messageId, reply);
      });
      const page = await conversations.listResumeSessions(resumeSelect.key, resumeSelect.scope, resumeSelect.page);
      return buildResumeCard(page);
    }

    const selectedThinking = parseThinkingActionValue(action.value);
    if (selectedThinking) {
      await conversations.selectThinkingLevel(selectedThinking.key, selectedThinking.level, async (reply) => {
        await transport?.replyText(action.messageId, reply);
      });
      const [currentModel, thinking] = await Promise.all([
        conversations.getSelectedModel(selectedThinking.key),
        conversations.getThinkingStatus(selectedThinking.key),
      ]);
      return buildThinkingCard(selectedThinking.key, currentModel, thinking);
    }

    const selected = parseModelActionValue(action.value);
    if (!selected) return;
    await conversations.selectModel(selected.key, selected.provider, selected.modelId, async (reply) => {
      await transport?.replyText(action.messageId, reply);
    });
    const models = await conversations.getAvailableModels();
    const currentModel = await conversations.getSelectedModel(selected.key);
    return buildModelCard(selected.key, models, currentModel);
  };
}

function parseCopyMarkdownActionValue(value: unknown): { copySourceId: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_copy_markdown") return undefined;
  if (typeof raw.copySourceId !== "string" || !raw.copySourceId) return undefined;
  return { copySourceId: raw.copySourceId };
}

export function copyToSystemClipboard(text: string): boolean {
  if (process.platform === "darwin") {
    try {
      const res = spawnSync("pbcopy", { input: text, encoding: "utf-8" });
      return res.status === 0;
    } catch {
      return false;
    }
  }
  if (process.platform === "linux") {
    try {
      const res = spawnSync("xclip", ["-selection", "clipboard"], { input: text, encoding: "utf-8" });
      if (res.status === 0) return true;
    } catch {}
    try {
      const res = spawnSync("wl-copy", { input: text, encoding: "utf-8" });
      if (res.status === 0) return true;
    } catch {}
  }
  return false;
}

export function openWorkspaceInIde(workspace: string): boolean {
  if (!workspace || !workspace.trim()) return false;
  const target = workspace.trim();
  if (process.platform === "darwin") {
    try {
      const res = spawnSync("open", ["-b", "com.microsoft.VSCode", target]);
      if (res.status === 0) return true;
    } catch {}
    try {
      const res = spawnSync("open", ["-a", "Visual Studio Code", target]);
      if (res.status === 0) return true;
    } catch {}
    try {
      const res = spawnSync("open", [`vscode://file${target.startsWith("/") ? "" : "/"}${target}`]);
      if (res.status === 0) return true;
    } catch {}
  }
  try {
    const res = spawnSync("code", [target]);
    return res.status === 0;
  } catch {}
  return false;
}
