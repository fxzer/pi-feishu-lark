import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCardKitCardJson,
  buildQuickActionButtons,
  buildStopButton,
  formatProgressSection,
  formatToolStepsMarkdown,
  formatToolSummary,
  getGitDiffSummary,
  parseQuickPromptActionValue,
  parseStopTaskActionValue,
  OPEN_IDE_ACTION,
  QUICK_PROMPT_ACTION,
  STOP_ACTION,
  type ToolStep,
} from "../src/feishu/card-builder.ts";
import { createCardActionHandler, openWorkspaceInIde } from "../src/feishu/card-actions.ts";
import { wrapCardActionCallbackResult } from "../src/feishu/transport.ts";
import { ReplyCard } from "../src/feishu/reply-card.ts";

function hasStopControl(card: unknown) {
  const s = JSON.stringify(card);
  return s.includes("停止") && s.includes(STOP_ACTION);
}

function headerTitle(card: any) {
  return card?.header?.title?.content;
}

test("running card always has stop button", () => {
  const card = buildCardKitCardJson({ key: "k1", status: "running", body: "hi", runId: "r1" });
  assert.equal(headerTitle(card), "回复中");
  assert.equal(hasStopControl(card), true);
  assert.equal(JSON.stringify(card).includes("任务"), false);
});

test("done card has no stop button", () => {
  const card = buildCardKitCardJson({ key: "k1", status: "done", body: "最终回复" });
  assert.equal(headerTitle(card), "回复");
  assert.equal(hasStopControl(card), false);
  assert.match(JSON.stringify(card), /最终回复/);
});

test("CardKit running card must include stop button and streaming config", () => {
  const card = buildCardKitCardJson({
    status: "running",
    body: "",
    key: "p2p:user",
    runId: "run-1",
    streaming: true,
    printFrequencyMs: 50,
    printStep: 1,
  }) as any;
  assert.equal(card.schema, "2.0");
  assert.equal(headerTitle(card), "回复中");
  assert.equal(card.config.streaming_mode, true);
  assert.equal(card.config.streaming_config.print_step.default, 1);
  assert.equal(hasStopControl(card), true);
  // content element id for CardKit PUT path
  const md = card.body.elements.find((e: any) => e.tag === "markdown");
  assert.equal(md.element_id, "content");
  assert.equal(md.content, "正在回复…");
  const btn = card.body.elements.find((e: any) => e.tag === "button");
  assert.ok(btn);
  assert.equal(btn.type, "danger");
  assert.equal(btn.behaviors?.[0]?.type, "callback");
  assert.equal(btn.behaviors?.[0]?.value?.action, STOP_ACTION);
  assert.equal(btn.behaviors?.[0]?.value?.key, "p2p:user");
  assert.equal(btn.behaviors?.[0]?.value?.runId, "run-1");
});

test("CardKit done card updates header and removes stop", () => {
  const card = buildCardKitCardJson({
    status: "done",
    body: "完整答案",
    key: "p2p:user",
    runId: "run-1",
    streaming: false,
  }) as any;
  assert.equal(headerTitle(card), "回复");
  assert.equal(card.config.streaming_mode, false);
  assert.equal(hasStopControl(card), false);
  assert.match(JSON.stringify(card), /完整答案/);
});

test("CardKit stopped/failed headers", () => {
  const s = buildCardKitCardJson({ status: "stopped", body: "半段", key: "k" }) as any;
  const f = buildCardKitCardJson({ status: "failed", body: "err", key: "k" }) as any;
  assert.equal(headerTitle(s), "已停止");
  assert.equal(headerTitle(f), "出错了");
  assert.equal(hasStopControl(s), false);
  assert.equal(hasStopControl(f), false);
});

test("buildStopButton payload is parseable by stop handler", () => {
  const btn = buildStopButton("conv-key", "run-xyz") as any;
  const parsed = parseStopTaskActionValue(btn.value);
  assert.deepEqual(parsed, { key: "conv-key", runId: "run-xyz" });
  const parsedBehavior = parseStopTaskActionValue(btn.behaviors[0].value);
  assert.deepEqual(parsedBehavior, { key: "conv-key", runId: "run-xyz" });
});

test("regression: streaming running card without key must not silently drop stop contract when key provided", () => {
  // 无 key 时无法回调停止，但有 key 时绝不能丢按钮（防 CardKit 路径回归）
  const withKey = buildCardKitCardJson({ status: "running", key: "k", runId: "r", streaming: true });
  const withoutKey = buildCardKitCardJson({ status: "running", streaming: true });
  assert.equal(hasStopControl(withKey), true);
  assert.equal(hasStopControl(withoutKey), false);
});

test("formatToolSummary formats bash commands and file paths with truncation", () => {
  assert.equal(formatToolSummary("bash", { command: "git status --short" }), "bash: git status --short");
  assert.equal(formatToolSummary("read_file", { path: "src/feishu/reply-card.ts" }), "read_file: src/feishu/reply-card.ts");
  assert.equal(formatToolSummary("edit", { file_path: "package.json" }), "edit: package.json");
  assert.equal(formatToolSummary("grep", { pattern: "buildReplyCard" }), "grep: buildReplyCard");
  const longCmd = "a".repeat(100);
  const truncated = formatToolSummary("bash", { command: longCmd });
  assert.ok(truncated.length <= 65);
  assert.ok(truncated.endsWith("…"));
});

test("formatToolStepsMarkdown renders completed and failed steps without running steps or folding", () => {
  const steps: ToolStep[] = [
    { id: "1", name: "bash", summary: "bash: git status", status: "done", startTime: 100, durationMs: 45 },
    { id: "2", name: "read_file", summary: "read_file: src/index.ts", status: "done", startTime: 200, durationMs: 120 },
    { id: "3", name: "edit", summary: "edit: src/index.ts", status: "error", startTime: 300, durationMs: 80 },
    { id: "4", name: "edit", summary: "edit: src/index.ts", status: "done", startTime: 400, durationMs: 50 },
    { id: "5", name: "bash", summary: "bash: npm test", status: "done", startTime: 500, durationMs: 1200 },
    { id: "6", name: "bash", summary: "bash: git diff", status: "running", startTime: 600 },
  ];

  const md = formatToolStepsMarkdown(steps);
  // 纯递增流：不收拢折叠，确保首行永久不变
  assert.doesNotMatch(md, /已收拢/);
  // running 中的步骤不渲染，避免状态变更篡改中间行
  assert.doesNotMatch(md, /\[执行中\]/);
  assert.match(md, /> \| ❌ \| `edit: src\/index\.ts` \| 80ms \|/);
  assert.match(md, /> \| ✅ \| `bash: npm test` \| 1\.2s \|/);
  assert.match(md, /> \| ✅ \| `bash: git status` \| 45ms \|/);
});

test("formatProgressSection builds static header and completed tool block without mutable status", () => {
  const steps: ToolStep[] = [
    { id: "1", name: "bash", summary: "bash: git status", status: "done", startTime: 100, durationMs: 50 },
  ];
  const section = formatProgressSection("正在执行 bash: npm test", steps, true);
  assert.doesNotMatch(section, /\*\*当前状态\*\*/);
  assert.doesNotMatch(section, /\(共 \d+ 步\)/);
  assert.match(section, /> \*\*执行步骤\*\*/);
  assert.match(section, /> \| 状态 \| 执行操作 \| 耗时 \|/);
  assert.match(section, /> \| :---: \| :--- \| :---: \|/);
  assert.match(section, /> \| ✅ \| `bash: git status` \| 50ms \|/);
});

test("ReplyCard captures tool execution lifecycle and updates status", async () => {
  const updatedCards: any[] = [];
  const fakeTransport = {
    async replyCard(_msgId: string, card: object) {
      return "fake-card-id";
    },
    async updateCard(_msgId: string, card: object) {
      updatedCards.push(card);
    },
  };

  const reply = new ReplyCard("p2p:test", "msg-123", fakeTransport, { enabled: false });
  await reply.start();

  // 1. Tool starts
  reply.updateFromEvent({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "bash",
    args: { command: "npm test" },
  });

  // 2. Tool ends
  reply.updateFromEvent({
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "bash",
    result: "ok",
    isError: false,
  });

  // 3. Text delta
  reply.updateFromEvent({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      delta: "测试全部通过！",
    },
  });
  reply.append("测试全部通过！");

  // 4. Finish
  await reply.finish("done");

  assert.ok(updatedCards.length >= 1);
  const finalCard = updatedCards[updatedCards.length - 1];
  const jsonStr = JSON.stringify(finalCard);
  assert.match(jsonStr, /执行步骤/);
  assert.match(jsonStr, /npm test/);
  assert.match(jsonStr, /测试全部通过！/);
});

test("parseQuickPromptActionValue validates quick prompt payload", () => {
  assert.equal(parseQuickPromptActionValue(null), undefined);
  assert.equal(parseQuickPromptActionValue({ action: "other" }), undefined);
  const valid = parseQuickPromptActionValue({
    action: QUICK_PROMPT_ACTION,
    key: "p2p:user1",
    prompt: "git diff",
  });
  assert.deepEqual(valid, { key: "p2p:user1", prompt: "git diff" });
});

test("buildQuickActionButtons only renders copy button when copySourceId is provided", () => {
  const withCopy = buildQuickActionButtons("key-1", true, "copy-1");
  const jsonWith = JSON.stringify(withCopy);
  assert.match(jsonWith, /复制原文/);
  assert.doesNotMatch(jsonWith, /查看完整 Diff/);
  assert.doesNotMatch(jsonWith, /运行项目测试/);
  assert.doesNotMatch(jsonWith, /查看状态/);

  const withoutCopy = buildQuickActionButtons("key-1", true);
  assert.equal(withoutCopy.length, 0);

  const withWorkspace = buildQuickActionButtons("key-1", true, "copy-1", "/Users/fxj/m/my-project") as any[];
  assert.equal(withWorkspace.length, 2);
  const ideBtn = withWorkspace[1];
  assert.equal(ideBtn.text.content, "在 IDE 中打开");
  assert.equal(ideBtn.value.action, OPEN_IDE_ACTION);
  assert.equal(ideBtn.value.workspace, "/Users/fxj/m/my-project");
  assert.equal(ideBtn.behaviors[0].type, "callback");
  assert.equal(ideBtn.behaviors[0].value.action, OPEN_IDE_ACTION);
  assert.equal(ideBtn.behaviors[0].value.workspace, "/Users/fxj/m/my-project");
});

test("CardKit Header 2.0 metadata and tags", () => {
  const card = buildCardKitCardJson({
    key: "p2p:user",
    status: "done",
    body: "回答完成",
    modelName: "deepseek/deepseek-chat",
    workspace: "/Users/fxj/m/project",
    elapsedMs: 3400,
    stepCount: 5,
    gitDiffCount: 2,
  }) as any;

  assert.equal(card.schema, "2.0");
  assert.equal(card.header.title.content, "回复");
  assert.match(card.header.subtitle.content, /耗时 3\.4s/);
  assert.match(card.header.subtitle.content, /工作区:/);

  const tags = card.header.text_tag_list;
  assert.ok(Array.isArray(tags));
  assert.equal(tags.length, 3); // 最多 3 个
  assert.equal(tags[0].text.content, "deepseek-chat");
  assert.equal(tags[0].color, "wathet");
  assert.equal(tags[1].text.content, "3.4s");
  assert.equal(tags[1].color, "green");
  assert.equal(tags[2].text.content, "2 文件变更");
  assert.equal(tags[2].color, "orange");
});

test("CardKit and ReplyCard done cards contain quick action buttons", () => {
  const cardkitDone = buildCardKitCardJson({
    key: "p2p:user",
    status: "done",
    body: "完成回答",
    hasGitChanges: true,
    copySourceId: "copy-id-1",
  });
  const ckStr = JSON.stringify(cardkitDone);
  assert.match(ckStr, /"tag":"column_set"/);
  assert.match(ckStr, /"flex_mode":"none"/);
  assert.match(ckStr, /复制原文/);
  assert.match(ckStr, /pi_feishu_copy_markdown/);
  assert.doesNotMatch(ckStr, /查看完整 Diff/);
  assert.doesNotMatch(ckStr, /运行项目测试/);
  assert.doesNotMatch(ckStr, /查看状态/);
});

test("ReplyCard done records copy source on transport", async () => {
  let savedSourceId = "";
  let savedMarkdown = "";
  const updatedCards: any[] = [];
  const fakeTransport = {
    async replyCard(_msgId: string, card: object) {
      return "fake-card-id";
    },
    async updateCard(_msgId: string, card: object) {
      updatedCards.push(card);
    },
    rememberMarkdownCopySource(sourceId: string, markdown: string) {
      savedSourceId = sourceId;
      savedMarkdown = markdown;
    },
  };

  const reply = new ReplyCard("p2p:test", "msg-123", fakeTransport, { enabled: false });
  await reply.start();
  reply.append("Markdown 内容：# 标题");
  await reply.finish("done");

  assert.equal(savedSourceId, reply.runId);
  assert.equal(savedMarkdown, "Markdown 内容：# 标题");
  assert.ok(updatedCards.length >= 1);
  const finalCardStr = JSON.stringify(updatedCards[updatedCards.length - 1]);
  assert.match(finalCardStr, /复制原文/);
  assert.match(finalCardStr, /pi_feishu_copy_markdown/);
});

test("getGitDiffSummary handles non-repo or clean repo safely", () => {
  assert.equal(getGitDiffSummary(undefined).count, 0);
  assert.equal(getGitDiffSummary("/tmp/non-existent-dir-123456").count, 0);
});

test("createCardActionHandler returns toast without replying text message on copy", async () => {
  let repliedTextCount = 0;
  const fakeTransport = {
    getMarkdownCopySource(id: string) {
      if (id === "valid-id") return "# 成功复制的内容";
      return undefined;
    },
    async replyPlainText() {
      repliedTextCount++;
    },
  };

  const handler = createCardActionHandler({} as any, () => fakeTransport as any);

  // 1. Valid copy action
  const res1 = await handler({
    messageId: "msg-1",
    chatId: "chat-1",
    operatorOpenId: "user-1",
    value: { action: "pi_feishu_copy_markdown", copySourceId: "valid-id" },
  });

  assert.equal(repliedTextCount, 0, "must not send plain text message");
  assert.deepEqual(res1, {
    toast: {
      type: "success",
      content: "已复制到剪贴板（共 9 字）",
      i18n: {
        zh_cn: "已复制到剪贴板（共 9 字）",
        en_us: "Copied to clipboard (9 chars)",
      },
    },
  });

  // 3. Open IDE action
  const res3 = await handler({
    messageId: "msg-1",
    chatId: "chat-1",
    operatorOpenId: "user-1",
    value: { action: OPEN_IDE_ACTION, workspace: "/Users/fxj/m/test-proj" },
  });
  assert.equal(repliedTextCount, 0);
  assert.ok(res3?.toast?.content.includes("VS Code"));
});

test("wrapCardActionCallbackResult preserves toast and wraps cards", () => {
  assert.equal(wrapCardActionCallbackResult(undefined), undefined);

  // Toast only
  const toastRes = wrapCardActionCallbackResult({ toast: { type: "success", content: "ok" } });
  assert.deepEqual(toastRes, { toast: { type: "success", content: "ok" } });

  // Normal Card
  const cardRes = wrapCardActionCallbackResult({ header: { title: "hi" } });
  assert.deepEqual(cardRes, { card: { type: "raw", data: { header: { title: "hi" } } } });
});

test("CardKit buildCardKitCardJson preserves append-only prefix when combining progress and body", () => {
  const steps: ToolStep[] = [
    { id: "1", name: "bash", summary: "bash: git status", status: "done", startTime: 100, durationMs: 45 },
    { id: "2", name: "read_file", summary: "read_file: src/index.ts", status: "done", startTime: 200, durationMs: 120 },
  ];

  const p1 = formatProgressSection([steps[0]]);
  const card1 = buildCardKitCardJson({ status: "running", progress: p1 });
  const content1 = (card1.body.elements[0] as any).content as string;

  const p2 = formatProgressSection(steps);
  const card2 = buildCardKitCardJson({ status: "running", progress: p2 });
  const content2 = (card2.body.elements[0] as any).content as string;
  assert.ok(content2.startsWith(content1), "Step 2 must start with Step 1 prefix");

  const card3 = buildCardKitCardJson({ status: "running", progress: p2, body: "第一段回答" });
  const content3 = (card3.body.elements[0] as any).content as string;
  assert.ok(content3.startsWith(content2), "Body streaming must start with tool steps prefix");

  const card4 = buildCardKitCardJson({ status: "running", progress: p2, body: "第一段回答，第二段回答" });
  const content4 = (card4.body.elements[0] as any).content as string;
  assert.ok(content4.startsWith(content3), "Body continuation must start with previous body prefix");

  const cardDone = buildCardKitCardJson({ status: "done", progress: p2, body: "第一段回答，第二段回答" });
  const panel = cardDone.body.elements[0] as any;
  assert.equal(panel.tag, "collapsible_panel");
  assert.equal(panel.expanded, false);
  assert.match(panel.header.title.content, /查看执行过程 \(共 2 步\)/);
  assert.equal(panel.elements[0].content, p2);

  const contentDone = (cardDone.body.elements[1] as any).content as string;
  assert.equal(contentDone, "第一段回答，第二段回答", "Done card presents concise body outside collapsible panel");
});
