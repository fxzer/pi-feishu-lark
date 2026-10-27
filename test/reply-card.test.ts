import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCardKitCardJson,
  buildReplyCard,
  buildStopButton,
  formatProgressSection,
  formatToolStepsMarkdown,
  formatToolSummary,
  parseStopTaskActionValue,
  STOP_ACTION,
  type ToolStep,
} from "../src/feishu/card-builder.ts";
import { ReplyCard } from "../src/feishu/reply-card.ts";

function hasStopControl(card: unknown) {
  const s = JSON.stringify(card);
  return s.includes("停止") && s.includes(STOP_ACTION);
}

function headerTitle(card: any) {
  return card?.header?.title?.content;
}

test("running interactive card always has stop button", () => {
  const card = buildReplyCard({ key: "k1", status: "running", body: "hi", runId: "r1" });
  assert.equal(headerTitle(card), "回复中");
  assert.equal(hasStopControl(card), true);
  assert.equal(JSON.stringify(card).includes("任务"), false);
});

test("done interactive card has no stop button", () => {
  const card = buildReplyCard({ key: "k1", status: "done", body: "最终回复" });
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

test("formatToolStepsMarkdown renders tool status and folds if more than 5 steps", () => {
  const steps: ToolStep[] = [
    { id: "1", name: "bash", summary: "bash: git status", status: "done", startTime: 100, durationMs: 45 },
    { id: "2", name: "read_file", summary: "read_file: src/index.ts", status: "done", startTime: 200, durationMs: 120 },
    { id: "3", name: "edit", summary: "edit: src/index.ts", status: "error", startTime: 300, durationMs: 80 },
    { id: "4", name: "edit", summary: "edit: src/index.ts", status: "done", startTime: 400, durationMs: 50 },
    { id: "5", name: "bash", summary: "bash: npm test", status: "done", startTime: 500, durationMs: 1200 },
    { id: "6", name: "bash", summary: "bash: git diff", status: "running", startTime: 600 },
  ];

  const runningMd = formatToolStepsMarkdown(steps, true);
  assert.match(runningMd, /已收拢前 1 个步骤/);
  assert.match(runningMd, /\[执行中\] `bash: git diff`/);
  assert.match(runningMd, /\[失败\] `edit: src\/index\.ts` \(80ms\)/);
  assert.match(runningMd, /\[完成\] `bash: npm test` \(1\.2s\)/);

  const doneMd = formatToolStepsMarkdown(steps, false);
  // done 时全量展示全部 6 步
  assert.doesNotMatch(doneMd, /已收拢/);
  assert.match(doneMd, /\[完成\] `bash: git status` \(45ms\)/);
});

test("formatProgressSection builds action header and tool block", () => {
  const steps: ToolStep[] = [
    { id: "1", name: "bash", summary: "bash: git status", status: "done", startTime: 100, durationMs: 50 },
  ];
  const section = formatProgressSection("正在执行 bash: npm test", steps, true);
  assert.match(section, /\*\*当前状态\*\*：正在执行 bash: npm test/);
  assert.match(section, /> \*\*执行步骤\*\* \(共 1 步\)/);
  assert.match(section, /> - \[完成\] `bash: git status` \(50ms\)/);
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
  assert.match(jsonStr, /执行过程/);
  assert.match(jsonStr, /npm test/);
  assert.match(jsonStr, /测试全部通过！/);
});
