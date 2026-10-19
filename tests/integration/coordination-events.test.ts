import assert from "node:assert/strict";
import test from "node:test";
import { isBoardWakeCandidate } from "../../src/integration/board-wake.ts";
import { canDeliverBoardEntry } from "../../src/integration/board-delivery.ts";
import { prepareInformationOutput } from "../../src/integration/information-output.ts";
import { isBoardDiscussionNotice } from "../../src/core/board-notifications.ts";
import {
  renderEventNotice,
  renderDiscussionNotice,
} from "../../src/integration/coordination-state.ts";

const notice = {
  id: "n2",
  taskId: "__nmg_event_updates__",
  agentId: "a",
  sequence: 0,
  kind: "note",
  status: "open",
  content: "Event closed without success",
  to: "b",
  eventId: "event-1",
  eventRevision: 2,
  eventNotice: true,
};
test("native wake accepts directed versioned updates, not ordinary notes or metadata lookalikes", () => {
  const reader = { agentId: "b", sessionId: "b-session" };
  assert.equal(isBoardWakeCandidate(notice, reader), true);
  assert.equal(isBoardWakeCandidate({ ...notice, eventNotice: false }, reader), false);
  assert.equal(isBoardWakeCandidate({ ...notice, eventRevision: 0 }, reader), false);
  assert.equal(isBoardWakeCandidate({ ...notice, to: "other" }, reader), false);
  assert.equal(isBoardWakeCandidate({ ...notice, status: "resolved" }, reader), false);
  assert.match(renderEventNotice(notice), /not a task handoff/);
  assert.match(renderEventNotice(notice), /eventUnsubscribe/);
});
test("discussion notice identity requires owner metadata and suppresses its raw routed source", () => {
  const discussion = {
    ...notice,
    eventNotice: false,
    notificationSourceId: "source",
    notificationChannelId: "channel",
    notificationScopes: ["direct" as const],
  };
  const reader = { agentId: "b", sessionId: "b-session" };
  assert.equal(isBoardDiscussionNotice(discussion), true);
  assert.equal(isBoardWakeCandidate(discussion, reader), true);
  assert.equal(isBoardDiscussionNotice({ ...discussion, notificationScopes: [] }), false);
  assert.equal(
    isBoardWakeCandidate({ ...discussion, notificationScopes: undefined }, reader),
    false,
  );
  assert.equal(isBoardWakeCandidate({ ...discussion, notificationOrigin: true }, reader), false);
});

test("discussion wake bounds previews with source labels but preserves the first invitation body", () => {
  const source = { notificationChannelId: "discussion", notificationSourceId: "source-1" };
  const text = renderDiscussionNotice({ ...source, content: "x".repeat(9000) });
  assert.match(text, /preview/);
  assert.match(text, /source-1/);
  assert.ok(text.length < 4000);
  const invitation = "First invitation " + "x".repeat(2900);
  assert.ok(
    renderDiscussionNotice({ ...source, content: invitation, invitation: true }).includes(
      invitation,
    ),
  );
});

test("old receipt is not a new-revision receipt; queued unsubscribe/expiry fails eligibility without inventing ack", () => {
  assert.equal(canDeliverBoardEntry({ delivered: ["n1"], acked: ["n1"] }, notice.id), true);
  assert.equal(canDeliverBoardEntry({ delivered: [notice.id] }, notice.id), false);
  assert.equal(canDeliverBoardEntry({ inactive: [notice.id] }, notice.id), false);
  assert.equal(canDeliverBoardEntry({ suppressed: true }, notice.id), false);
  assert.equal(canDeliverBoardEntry(null, notice.id), false);
});
test("event source identity retains revision and record/change distinction under shared whole-item budgets", () => {
  const views = [1, 2].flatMap((revision) =>
    (["record", "change"] as const).map((part) => ({
      source: { kind: "event" as const, eventId: "e", revision, part },
      body: "same text",
    })),
  );
  const output = prepareInformationOutput(views);
  assert.equal(output.included.length, 4);
  assert.equal(prepareInformationOutput(views, { maxCharacters: 1 }).included.length, 0);
});
