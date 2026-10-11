/**
 * Scheduler: persistent-задания с ключом идемпотентности, тихие часы
 * (quiet hours) в зоне владельца, перенос и ограничение повторов.
 *
 * Допущение G1: все времена уже приведены к локальной зоне владельца
 * (runAt, quietHours — локальные часы; смена зоны владельца — отдельная
 * задача этапа G2+). Это зафиксировано в README.
 */

export interface QuietHours {
  /** "HH:MM" локального времени владельца, включительно. */
  start: string;
  /** "HH:MM" локального времени владельца, эксклюзивно. */
  end: string;
}

export type TaskStatus = "scheduled" | "running" | "done" | "cancelled" | "failed";

export interface ScheduledTask {
  /** Ключ идемпотентности: повторный schedule с тем же ключом — no-op. */
  key: string;
  action: string;
  runAt: Date;
  quietHours: QuietHours | null;
  maxAttempts: number;
  attempts: number;
  status: TaskStatus;
  lastError: string | null;
  createdAt: Date;
}

export interface ScheduleInput {
  key: string;
  action: string;
  runAt: Date;
  quietHours?: QuietHours | null;
  maxAttempts?: number;
}

export type TaskResult =
  | { ok: true; value?: unknown }
  | { ok: false; error: string };

type Executor = (task: ScheduledTask) => Promise<TaskResult> | TaskResult;

function minutesOfDay(hhmm: string): number {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`Invalid HH:MM time: "${hhmm}"`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Invalid HH:MM time: "${hhmm}"`);
  return h * 60 + min;
}

function setMinutesOfDay(d: Date, minutes: number): Date {
  const r = new Date(d);
  r.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return r;
}

/** Попадает ли локальное время в тихие часы. */
export function isQuietTime(localNow: Date, quiet: QuietHours): boolean {
  const cur = localNow.getHours() * 60 + localNow.getMinutes();
  const start = minutesOfDay(quiet.start);
  const end = minutesOfDay(quiet.end);
  if (start === end) return false; // пустое окно
  if (start < end) return cur >= start && cur < end;
  // Окно через полночь, например 22:00–08:00.
  return cur >= start || cur < end;
}

/** Ближайшее локальное время после окончания тихих часов. */
export function quietWindowEnd(after: Date, quiet: QuietHours): Date {
  const end = minutesOfDay(quiet.end);
  let candidate = setMinutesOfDay(after, end);
  if (candidate.getTime() <= after.getTime()) {
    candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
  }
  return candidate;
}

export class Scheduler {
  private tasks = new Map<string, ScheduledTask>();

  /** Идемпотентно: существующая задача с таким ключом возвращается как есть. */
  schedule(input: ScheduleInput, now: Date = new Date()): ScheduledTask {
    const existing = this.tasks.get(input.key);
    if (existing) return existing;
    const task: ScheduledTask = {
      key: input.key,
      action: input.action,
      runAt: input.runAt,
      quietHours: input.quietHours ?? null,
      maxAttempts: input.maxAttempts ?? 3,
      attempts: 0,
      status: "scheduled",
      lastError: null,
      createdAt: now,
    };
    task.runAt = this.applyQuietHours(task.runAt, task.quietHours);
    this.tasks.set(task.key, task);
    return task;
  }

  /** Если runAt попадает в тихие часы — перенос на конец окна. */
  applyQuietHours(runAt: Date, quiet: QuietHours | null): Date {
    if (!quiet) return runAt;
    if (!isQuietTime(runAt, quiet)) return runAt;
    return quietWindowEnd(runAt, quiet);
  }

  /** Перенос задачи владельцем; учитывает тихие часы. */
  postpone(key: string, newRunAt: Date): ScheduledTask {
    const task = this.mustGet(key);
    if (task.status !== "scheduled") {
      throw new Error(`postpone: task ${key} is ${task.status}`);
    }
    task.runAt = this.applyQuietHours(newRunAt, task.quietHours);
    return task;
  }

  cancel(key: string): ScheduledTask {
    const task = this.mustGet(key);
    task.status = "cancelled";
    return task;
  }

  /** Все задачи, подлежащие выполнению на момент localNow. */
  due(localNow: Date): ScheduledTask[] {
    return [...this.tasks.values()].filter(
      (t) => t.status === "scheduled" && t.runAt.getTime() <= localNow.getTime(),
    );
  }

  /**
   * Выполнить все due-задачи. При ошибке: перепланирование с экспоненциальным
   * backoff (5 мин * 2^attempts), но не более maxAttempts попыток — далее failed.
   */
  async runDue(localNow: Date, executor: Executor): Promise<ScheduledTask[]> {
    const ran: ScheduledTask[] = [];
    for (const task of this.due(localNow)) {
      task.status = "running";
      task.attempts += 1;
      const result = await executor(task);
      if (result.ok) {
        task.status = "done";
        task.lastError = null;
      } else if (task.attempts >= task.maxAttempts) {
        task.status = "failed";
        task.lastError = result.error;
      } else {
        task.status = "scheduled";
        task.lastError = result.error;
        const backoffMs = 5 * 60 * 1000 * 2 ** (task.attempts - 1);
        const next = new Date(localNow.getTime() + backoffMs);
        task.runAt = this.applyQuietHours(next, task.quietHours);
      }
      ran.push(task);
    }
    return ran;
  }

  get(key: string): ScheduledTask | undefined {
    return this.tasks.get(key);
  }

  all(): ScheduledTask[] {
    return [...this.tasks.values()];
  }

  private mustGet(key: string): ScheduledTask {
    const task = this.tasks.get(key);
    if (!task) throw new Error(`Unknown task key: ${key}`);
    return task;
  }
}
