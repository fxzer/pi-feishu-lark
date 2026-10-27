import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import {
  buildWorkspaceCard,
  parseWorkspaceNavActionValue,
  parseWorkspaceSelectActionValue,
} from "../src/feishu/cards.ts";

test("workspace card renders current workspace and action buttons", () => {
  const home = homedir();
  const card = buildWorkspaceCard("p2p:user", home) as any;

  assert.equal(card.header.title.content, "选择工作区目录");
  assert.match(card.elements[0].content, /当前工作区：/);

  // Check that at least one action element exists
  const actionElements = card.elements.filter((e: any) => e.tag === "action");
  assert.ok(actionElements.length > 0);
});

test("workspace card parses select and nav action payloads", () => {
  const selectPayload = {
    action: "pi_feishu_select_workspace",
    key: "p2p:user",
    path: "/Users/test/m/my-project",
    page: 0,
  };
  const parsedSelect = parseWorkspaceSelectActionValue(selectPayload);
  assert.ok(parsedSelect);
  assert.equal(parsedSelect.path, "/Users/test/m/my-project");
  assert.equal(parsedSelect.key, "p2p:user");

  const navPayload = {
    action: "pi_feishu_workspace_nav",
    key: "group:123",
    path: "/Users/test",
    page: 1,
  };
  const parsedNav = parseWorkspaceNavActionValue(navPayload);
  assert.ok(parsedNav);
  assert.equal(parsedNav.path, "/Users/test");
  assert.equal(parsedNav.page, 1);

  // Invalid payload returns undefined
  assert.equal(parseWorkspaceSelectActionValue({ action: "other" }), undefined);
  assert.equal(parseWorkspaceNavActionValue(null), undefined);
});
