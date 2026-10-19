import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Constructor, TransactionPort } from "./store-ctor.ts";
import { WORLD_BOARD_ID, type TaskBoardEntry, type TaskBoardKind } from "../types.ts";
import {
  applyCoordinationMutation,
  coordinationNames,
  coordinationText,
  coordinationPageLimit,
  EVENT_NOTICE_CHANNEL,
  parseCoordinationMutation,
  type AgentWorkStatus,
  type CoordinationEvent,
  type CoordinationEventChange,
  type CreateCoordinationEvent,
  type UpdateCoordinationEvent,
} from "../coordination-events.ts";

import type { BoardMessageInput } from "../board-notifications.ts";
import {
  boardNoticeInactive,
  coalesceNotices,
  retireBoardNoticeScope,
  setChannelMembership,
  writeBoardMessage,
} from "./board-notifications.ts";

type Row = Record<string, unknown>;
export function withCoordination<TBase extends Constructor>(Base: TBase) {
  return class extends Base {
    declare protected db: DatabaseSync;
    declare writeTransaction: <T>(run: (port: TransactionPort) => T) => T;
    declare putTaskBoardEntry: (
      input: {
        taskId: string;
        agentId: string;
        kind: TaskBoardKind;
        content: string;
        expiresAt: string;
        to?: string;
        sourceSessionId?: string;
        eventId?: string;
      },
      port?: TransactionPort,
    ) => TaskBoardEntry;
    declare resolveTaskBoardEntry: (input: {
      taskId: string;
      entryId: string;
      agentId: string;
      resolution: string;
    }) => TaskBoardEntry;

    declare getTaskBoardEntryById: (taskId: string, entryId: string) => TaskBoardEntry | null;
    declare subscribeTaskBoard: (input: { sessionId: string; taskId: string }) => void;
    declare unsubscribeTaskBoard: (input: { sessionId: string; taskId: string }) => void;
    declare suppressTaskBoard: (input: { sessionId: string; taskId: string }) => void;
    declare unsuppressTaskBoard: (input: { sessionId: string; taskId: string }) => void;
    declare listTaskBoardSubscriptions: (
      sessionId: string,
    ) => Array<{ taskId: string; subscribedAt: string }>;

    postBoardMessage(input: BoardMessageInput): TaskBoardEntry {
      return this.writeTransaction((port) =>
        writeBoardMessage(
          this.db,
          {
            put: this.putTaskBoardEntry.bind(this),
            get: this.getTaskBoardEntryById.bind(this),
            resolve: this.resolveTaskBoardEntry.bind(this),
          },
          input,
          port,
        ),
      );
    }

    setBoardChannelSubscription(input: {
      agentId: string;
      sessionId: string;
      taskId: string;
      subscribed: boolean;
    }): void {
      this.writeTransaction(() => {
        setChannelMembership(this.db, input.taskId, input.agentId, input.subscribed);
        if (input.subscribed) {
          this.subscribeTaskBoard(input);
          this.unsuppressTaskBoard(input);
        } else {
          this.unsubscribeTaskBoard(input);
          this.suppressTaskBoard(input);
          retireBoardNoticeScope(
            this.db,
            { resolve: this.resolveTaskBoardEntry.bind(this) },
            { agentId: input.agentId, scope: "channel", targetId: input.taskId },
          );
        }
      });
    }

    listBoardChannelSubscriptions(input: {
      agentId: string;
      sessionId: string;
    }): Array<{ taskId: string; subscribedAt: string }> {
      const result = new Map(
        this.listTaskBoardSubscriptions(input.sessionId).map((item) => [item.taskId, item]),
      );
      for (const row of this.db
        .prepare(
          "SELECT task_id,subscribed,subscribed_at FROM board_channel_members WHERE agent_id=? AND task_id!=?",
        )
        .all(input.agentId, WORLD_BOARD_ID)) {
        const taskId = String(row.task_id);
        if (row.subscribed === 1)
          result.set(taskId, { taskId, subscribedAt: String(row.subscribed_at) });
        else result.delete(taskId);
      }
      return [...result.values()];
    }

    createCoordinationEvent(input: CreateCoordinationEvent): CoordinationEvent {
      const actor = coordinationText(input.agentId, "agentId", 200),
        now = new Date().toISOString();
      const event: CoordinationEvent = {
        id: randomUUID(),
        title: coordinationText(input.title, "event title", 200),
        summary: coordinationText(input.summary ?? "", "event summary", 3000, true),
        initiator: actor,
        updatedBy: actor,
        revision: 1,
        status: "active",
        outcome: null,
        parentId: input.parentId ? coordinationText(input.parentId, "parentId", 200) : null,
        dependencies: coordinationNames(input.dependencies, "dependencies"),
        resources: coordinationNames(input.resources, "resources"),
        participants: [
          ...new Set([actor, ...coordinationNames(input.participants, "participants")]),
        ],
        channels: [],
        effects: [],
        startedAt: now,
        updatedAt: now,
        endedAt: null,
      };
      const creation: CoordinationEventChange["payload"] = {
        kind: "created",
        text: event.title,
        record: event,
      };
      if (JSON.stringify(creation).length > 6000)
        throw new Error(
          "Initial event context exceeds 6000 characters; shorten summaries or relations",
        );
      return this.writeTransaction((port) => {
        this.checkCoordinationReferences(event);
        this.db
          .prepare(
            "INSERT INTO coordination_events(id,status,revision,updated_at,record_json) VALUES(?,?,?,?,?)",
          )
          .run(event.id, event.status, 1, now, JSON.stringify(event));
        this.appendCoordinationChange(event, creation, port);
        return event;
      });
    }

    updateCoordinationEvent(input: UpdateCoordinationEvent): CoordinationEvent {
      const actor = coordinationText(input.agentId, "agentId", 200);
      const change = parseCoordinationMutation(input.change);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
        throw new Error("expectedRevision must be a positive integer");
      return this.writeTransaction((port) => {
        const current = this.coordinationEvent(input.eventId);
        if (current.revision !== input.expectedRevision)
          throw new Error("Event revision changed; read before updating");
        const associated = this.db
          .prepare(
            "SELECT associated FROM coordination_event_members WHERE event_id=? AND agent_id=?",
          )
          .get(current.id, actor);
        if (!current.participants.includes(actor) && associated?.associated !== 1)
          throw new Error(
            "Only event participants may change this record; subscription alone does not grant authority",
          );
        const next = applyCoordinationMutation(current, change, actor);
        this.checkCoordinationReferences(next);
        next.revision++;
        next.updatedBy = actor;
        next.updatedAt = new Date().toISOString();
        if (change.kind === "close") next.endedAt = next.updatedAt;
        const changed = this.db
          .prepare(
            "UPDATE coordination_events SET status=?,revision=?,updated_at=?,active_effects=?,record_json=? WHERE id=? AND revision=?",
          )
          .run(
            next.status,
            next.revision,
            next.updatedAt,
            Number(next.effects.some((effect) => effect.state === "active")),
            JSON.stringify(next),
            next.id,
            input.expectedRevision,
          );
        if (Number(changed.changes) !== 1) throw new Error("Event revision changed");
        this.appendCoordinationChange(next, change, port);
        return next;
      });
    }

    readCoordinationEvent(
      eventId: string,
      options: { afterRevision?: number; limit?: number } = {},
    ) {
      const event = this.coordinationEvent(eventId);
      const after = options.afterRevision ?? 0;
      if (!Number.isSafeInteger(after) || after < 0 || after > event.revision)
        throw new Error("Invalid event revision cursor");
      const changes = this.db
        .prepare(
          "SELECT * FROM coordination_event_changes WHERE event_id=? AND revision>? ORDER BY revision LIMIT ?",
        )
        .all(eventId, after, coordinationPageLimit(options.limit, 50)) as Row[];
      const history: CoordinationEventChange[] = changes.map((row) => ({
        revision: Number(row.revision),
        actorId: String(row.actor_id),
        kind: String(row.kind),
        text: String(row.text),
        payload: JSON.parse(String(row.payload_json)) as CoordinationEventChange["payload"],
        createdAt: String(row.created_at),
      }));
      const last = history.at(-1)?.revision;
      const channelDetails = event.channels.map((channel) => ({
        channelId: channel.channelId,
        available: !!this.db
          .prepare("SELECT 1 FROM task_board_entries WHERE task_id=? AND expires_at>? LIMIT 1")
          .get(channel.channelId, new Date().toISOString()),
      }));
      return {
        event,
        changes: history,
        nextRevision: last !== undefined && last < event.revision ? last : undefined,
        channelDetails,
        members: this.db
          .prepare(
            "SELECT agent_id,subscribed,associated FROM coordination_event_members WHERE event_id=? ORDER BY agent_id",
          )
          .all(eventId)
          .map((row) => ({
            agentId: String(row.agent_id),
            subscribed: row.subscribed === 1,
            associated: row.associated === 1,
          })),
      };
    }

    listCoordinationEvents(
      options: { includeEnded?: boolean; limit?: number; offset?: number } = {},
    ): CoordinationEvent[] {
      const offset = options.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid event list offset");
      return (
        this.db
          .prepare(
            "SELECT record_json FROM coordination_events WHERE (?=1 OR status='active' OR active_effects=1) ORDER BY active_effects DESC,updated_at DESC,id LIMIT ? OFFSET ?",
          )
          .all(
            Number(options.includeEnded === true),
            coordinationPageLimit(options.limit, 20),
            offset,
          ) as Row[]
      ).map((row) => JSON.parse(String(row.record_json)) as CoordinationEvent);
    }

    subscribeCoordinationEvent(input: { eventId: string; agentId: string }): void {
      this.coordinationEvent(input.eventId);
      const actor = coordinationText(input.agentId, "agentId", 200);
      this.db
        .prepare(
          "INSERT INTO coordination_event_members(event_id,agent_id,subscribed) VALUES(?,?,1) ON CONFLICT(event_id,agent_id) DO UPDATE SET subscribed=1",
        )
        .run(input.eventId, actor);
    }

    unsubscribeCoordinationEvent(input: { eventId: string; agentId: string }): void {
      this.coordinationEvent(input.eventId);
      const actor = coordinationText(input.agentId, "agentId", 200);
      this.writeTransaction(() => {
        this.db
          .prepare(
            "INSERT INTO coordination_event_members(event_id,agent_id,subscribed) VALUES(?,?,0) ON CONFLICT(event_id,agent_id) DO UPDATE SET subscribed=0",
          )
          .run(input.eventId, actor);
        retireBoardNoticeScope(
          this.db,
          { resolve: this.resolveTaskBoardEntry.bind(this) },
          { agentId: actor, scope: "event", targetId: input.eventId },
        );
        const entries = this.db
          .prepare(
            "SELECT id,task_id FROM task_board_entries WHERE coordination_event_id=? AND coordination_notice=1 AND [to]=? AND status='open'",
          )
          .all(input.eventId, actor);
        for (const entry of entries)
          this.resolveTaskBoardEntry({
            taskId: String(entry.task_id),
            entryId: String(entry.id),
            agentId: actor,
            resolution: "Event subscription disabled",
          });
      });
    }

    deleteCoordinationEvent(input: {
      eventId: string;
      agentId: string;
      expectedRevision: number;
    }): void {
      this.writeTransaction(() => {
        const event = this.coordinationEvent(input.eventId);
        if (event.initiator !== input.agentId)
          throw new Error("Only the event initiator may explicitly delete its archive");
        if (event.revision !== input.expectedRevision) throw new Error("Event revision changed");
        if (event.status !== "ended" || event.effects.some((effect) => effect.state === "active"))
          throw new Error("End event and release active effects before deletion");
        const children = this.db
          .prepare("SELECT record_json FROM coordination_events WHERE id!=?")
          .all(event.id) as Row[];
        if (
          children.some((row) =>
            referencesEvent(JSON.parse(String(row.record_json)) as CoordinationEvent, event.id),
          )
        )
          throw new Error("Event has dependent/child references");
        if (
          this.db
            .prepare(
              "SELECT 1 FROM task_board_entries WHERE coordination_event_id=? AND coordination_notice=0 LIMIT 1",
            )
            .get(event.id)
        )
          throw new Error("Event still has channel task references");
        for (const table of ["task_board_acks", "task_board_deliveries"])
          this.db
            .prepare(
              `DELETE FROM ${table} WHERE entry_id IN (SELECT id FROM task_board_entries WHERE coordination_event_id=? AND coordination_notice=1)`,
            )
            .run(event.id);
        this.db
          .prepare(
            "DELETE FROM task_board_entries WHERE coordination_event_id=? AND coordination_notice=1",
          )
          .run(event.id);
        this.db.prepare("DELETE FROM coordination_events WHERE id=?").run(event.id);
      });
    }

    setAgentStatusNote(input: { agentId: string; text: string }): AgentWorkStatus {
      const actor = coordinationText(input.agentId, "agentId", 200),
        text = coordinationText(input.text, "status note", 500, true);
      const now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT OR IGNORE INTO task_board_agents(id,agent_name,created_at,last_seen_at) VALUES(?,?,?,?)",
        )
        .run(actor, actor, now, now);
      this.db
        .prepare("UPDATE task_board_agents SET status_note=?,last_seen_at=? WHERE id=?")
        .run(text, now, actor);
      return this.getAgentWorkStatus(actor);
    }

    getAgentWorkStatus(agentId: string, now = new Date().toISOString()): AgentWorkStatus {
      if (typeof agentId !== "string" || !agentId.trim()) throw new Error("agentId is required");
      const note = this.db
        .prepare("SELECT status_note FROM task_board_agents WHERE id=?")
        .get(agentId);
      const rows = this.db
        .prepare(
          `SELECT id,task_id,content,coordination_event_id,COUNT(*) OVER() AS total FROM task_board_entries
        WHERE status='open' AND expires_at>? AND coordination_notice=0 AND
        ((claimed_by=? AND claim_expires_at>?) OR (kind='goal' AND agent_id=? AND claimed_by IS NULL AND attempt=0 AND [to] IS NULL))
        ORDER BY created_at,id LIMIT 20`,
        )
        .all(now, agentId, now, agentId);
      return {
        agentId,
        activity: rows.length ? "working" : "idle",
        statusNote: String(note?.status_note ?? ""),
        taskCount: Number(rows[0]?.total ?? 0),
        tasks: rows.map((row) => ({
          entryId: String(row.id),
          taskId: String(row.task_id),
          summary: String(row.content).slice(0, 200),
          ...(typeof row.coordination_event_id === "string"
            ? { eventId: row.coordination_event_id }
            : {}),
        })),
      };
    }

    inactiveTaskBoardEntries(
      entryIds: readonly string[],
      now = new Date().toISOString(),
    ): string[] {
      const entry = this.db.prepare("SELECT * FROM task_board_entries WHERE id=?");
      const member = this.db.prepare(
        "SELECT subscribed FROM coordination_event_members WHERE event_id=? AND agent_id=?",
      );
      return entryIds.filter((id) => {
        const row = entry.get(id);
        if (!row || row.status !== "open" || String(row.expires_at) <= now) return true;
        if (boardNoticeInactive(this.db, row)) return true;
        return (
          row.coordination_notice === 1 &&
          member.get(String(row.coordination_event_id), String(row.to))?.subscribed !== 1
        );
      });
    }

    private coordinationEvent(id: string): CoordinationEvent {
      const row = this.db.prepare("SELECT record_json FROM coordination_events WHERE id=?").get(id);
      if (!row) throw new Error("Coordination event not found");
      return JSON.parse(String(row.record_json)) as CoordinationEvent;
    }
    private checkCoordinationReferences(event: CoordinationEvent): void {
      for (const id of [...event.dependencies, ...(event.parentId ? [event.parentId] : [])]) {
        if (id === event.id) throw new Error("Event cannot depend on itself");
        this.coordinationEvent(id);
      }
      if (event.channels.length > 32 || event.effects.length > 32 || event.participants.length > 32)
        throw new Error("Event relation limit is 32 per collection");
    }
    private appendCoordinationChange(
      event: CoordinationEvent,
      change: CoordinationEventChange["payload"],
      port: TransactionPort,
    ): void {
      this.db
        .prepare(
          "INSERT INTO coordination_event_changes(event_id,revision,actor_id,kind,text,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          event.id,
          event.revision,
          event.updatedBy,
          change.kind,
          change.text,
          JSON.stringify(change),
          event.updatedAt,
        );
      for (const agentId of event.participants)
        this.db
          .prepare(
            "INSERT INTO coordination_event_members(event_id,agent_id,subscribed,associated) VALUES(?,?,1,1) ON CONFLICT(event_id,agent_id) DO UPDATE SET associated=1",
          )
          .run(event.id, agentId);
      if (change.kind === "note") return;
      const members = this.db
        .prepare(
          "SELECT agent_id FROM coordination_event_members WHERE event_id=? AND subscribed=1 AND agent_id!=?",
        )
        .all(event.id, event.updatedBy);
      for (const member of members)
        this.createCoordinationNotice(event, String(member.agent_id), change.text, port);
    }
    private createCoordinationNotice(
      event: CoordinationEvent,
      agentId: string,
      text: string,
      port: TransactionPort,
    ): void {
      coalesceNotices(
        this.db,
        { resolve: this.resolveTaskBoardEntry.bind(this) },
        "coordination_notice=1 AND coordination_event_id=? AND [to]=?",
        [event.id, agentId],
      );
      const entry = this.putTaskBoardEntry(
        {
          taskId: EVENT_NOTICE_CHANNEL,
          agentId: event.updatedBy,
          kind: "note",
          to: agentId,
          content: `Event ${event.id} r${event.revision} [${event.status}] ${event.title}: ${text}`,
          expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        },
        port,
      );
      this.db
        .prepare(
          "UPDATE task_board_entries SET coordination_event_id=?,coordination_event_revision=?,coordination_notice=1 WHERE id=?",
        )
        .run(event.id, event.revision, entry.id);
    }
  };
}
function referencesEvent(event: CoordinationEvent, id: string): boolean {
  return event.parentId === id || event.dependencies.includes(id);
}
