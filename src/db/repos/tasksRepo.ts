import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Queryable } from "../dataSource.js";
import type { DueDate, Task, TaskAssignee, TaskPriority, TaskStatus } from "../../core/tasks.js";

/** Персист задач. Ключ (owner_id, key) уникален — повторное создание той же
 * задачи по той же person link даёт новую версию (prev_version_id), а не дубль. */

export const dueDateSchema = z.union([
  z.object({ kind: z.literal("absolute"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({
    kind: z.literal("relative"),
    description: z.string(),
    baseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    range: z.object({ from: z.string(), to: z.string() }).optional(),
    ambiguous: z.boolean(),
  }),
]);

export const taskInputSchema = z.object({
  assignee: z.enum(["owner", "contact"]).default("owner"),
  personId: z.string().nullable().optional(),
  action: z.string().min(1),
  source: z.string().min(1),
  due: dueDateSchema.nullable().optional(),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  ownerId: z.string().min(1),
});

export interface TaskRow {
  id: string;
  ownerId: string;
  key: string;
  assignee: TaskAssignee;
  personId: string | null;
  action: string;
  source: string;
  due: DueDate | null;
  priority: TaskPriority;
  status: TaskStatus;
  closeReason: string | null;
  closeRule: "manual" | "explicit-auto" | null;
  version: number;
  prevVersionId: string | null;
  createdAt: Date;
}

export function taskKey(input: { personId?: string | null | undefined; action: string; source: string }): string {
  return `${input.personId ?? "owner"}|${input.action}|${input.source}`;
}

export async function insertTask(q: Queryable, input: z.infer<typeof taskInputSchema>, version = 1, prevVersionId: string | null = null): Promise<TaskRow> {
  const baseKey = taskKey(input);
  // Каждая версия — отдельная строка: UNIQUE(owner_id, key) на ключе с суффиксом версии.
  const key = `${baseKey}#v${version}`;
  const id = randomUUID();
  try {
    await q.query(
      `INSERT INTO tasks
         (id, owner_id, key, title, status, due_on, source,
          assignee, person_id, due, priority, version, prev_version_id)
       VALUES ($1, $2, $3, $4, 'open', NULL, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id, input.ownerId, key, input.action, input.source,
        input.assignee, input.personId ?? null,
        input.due ? JSON.stringify(input.due) : null,
        input.priority, version, prevVersionId,
      ],
    );
  } catch {
    // UNIQUE(owner_id, key): такая версия уже есть — поднимаем версию.
    const existing = await q.query<{ id: string; version: number }>(
      `SELECT id, version FROM tasks WHERE owner_id = $1 AND key LIKE $2 || '#v%' ORDER BY version DESC LIMIT 1`,
      [input.ownerId, baseKey],
    );
    const ex = existing.rows[0];
    if (!ex) throw new Error("insertTask: conflict without existing task");
    await q.query(`UPDATE tasks SET status = 'cancelled', close_reason = $1 WHERE id = $2`, [
      `superseded by new version`, ex.id,
    ]);
    return insertTaskWithNewId(q, input, baseKey, (ex.version as number) + 1, ex.id);
  }
  return {
    id, ownerId: input.ownerId, key: baseKey, assignee: input.assignee, personId: input.personId ?? null,
    action: input.action, source: input.source, due: input.due ?? null, priority: input.priority,
    status: "open", closeReason: null, closeRule: null, version, prevVersionId, createdAt: new Date(),
  };
}

async function insertTaskWithNewId(
  q: Queryable, input: z.infer<typeof taskInputSchema>, baseKey: string, version: number, prevVersionId: string,
): Promise<TaskRow> {
  const id = randomUUID();
  await q.query(
    `INSERT INTO tasks
       (id, owner_id, key, title, status, due_on, source,
        assignee, person_id, due, priority, version, prev_version_id)
     VALUES ($1, $2, $3, $4, 'open', NULL, $5, $6, $7, $8, $9, $10, $11)`,
    [id, input.ownerId, `${baseKey}#v${version}`, input.action, input.source, input.assignee, input.personId ?? null,
     input.due ? JSON.stringify(input.due) : null, input.priority, version, prevVersionId],
  );
  return {
    id, ownerId: input.ownerId, key: baseKey, assignee: input.assignee, personId: input.personId ?? null,
    action: input.action, source: input.source, due: input.due ?? null, priority: input.priority,
    status: "open", closeReason: null, closeRule: null, version, prevVersionId, createdAt: new Date(),
  };
}

export async function listTasks(q: Queryable, opts: { ownerId: string; status?: TaskStatus | undefined }): Promise<TaskRow[]> {
  const res = await q.query<TaskRow>(
    `SELECT id, owner_id AS "ownerId", key, assignee, person_id AS "personId",
            title AS "action", source, due, priority, status,
            close_reason AS "closeReason", NULL AS "closeRule", version,
            prev_version_id AS "prevVersionId", created_at AS "createdAt"
     FROM tasks
     WHERE owner_id = $1 ${opts.status ? "AND status = $2" : ""}
     ORDER BY created_at DESC`,
    opts.status ? [opts.ownerId, opts.status] : [opts.ownerId],
  );
  return res.rows;
}

export async function setTaskStatus(
  q: Queryable,
  id: string,
  status: TaskStatus,
  closeReason: string | null,
  closeRule: "manual" | "explicit-auto" | null,
): Promise<void> {
  await q.query(
    `UPDATE tasks SET status = $1, close_reason = $2 WHERE id = $3`,
    [status, closeReason, id],
  );
  void closeRule; // фиксируем в payload-истории этапа G4; в G3 правило видно из closeReason-префикса
}
