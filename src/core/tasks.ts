/**
 * Обязательства и дела (G3-5).
 * - Относительные сроки: базовый набор RU/TR/EN, результат — абсолютная дата
 *   ИЛИ диапазон с флагом ambiguous (не угадываем); привязка к дате-основанию
 *   и IANA-зоне владельца.
 * - Отмена/изменение из другого мессенджера — новая ВЕРСИЯ задачи (по person link),
 *   а не вторая задача.
 * - Автоматическое закрытие — только по явному правилу; ручное закрытие
 *   переживает повторный анализ (AT-18).
 */

export type TaskStatus = "open" | "done" | "cancelled";
export type TaskAssignee = "owner" | "contact";
export type TaskPriority = "low" | "normal" | "high";

export type DueDate =
  | { kind: "absolute"; date: string } // YYYY-MM-DD (стена часового пояса владельца)
  | {
      kind: "relative";
      description: string;   // исходная формулировка
      baseDate: string;      // дата-основание (стена tz)
      date?: string | undefined;         // если удалось свести к одной дате
      range?: { from: string; to: string } | undefined; // иначе диапазон
      ambiguous: boolean;
    };

export interface Task {
  id: string;
  assignee: TaskAssignee;
  personId: string | null;   // контакт (для assignee=contact); owner-дела — null
  action: string;
  source: string;            // откуда взято: 'message:<id>' | 'manual' | ...
  due: DueDate | null;
  priority: TaskPriority;
  status: TaskStatus;
  closeReason: string | null;
  closeRule: "manual" | "explicit-auto" | null;
  version: number;
  prevVersionId: string | null;
  createdAt: Date;
}

/* ---------- относительные сроки ---------- */

interface WallDate {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
  weekday: number; // 1=Mon .. 7=Sun (в зоне tz)
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function wallDateOf(instant: Date, tz: string): WallDate {
  let dtf = dtfCache.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "numeric", day: "numeric", weekday: "short",
    });
    dtfCache.set(tz, dtf);
  }
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) parts[p.type] = p.value;
  const wd: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    weekday: wd[parts.weekday ?? "Mon"] ?? 1,
  };
}

function addDays(w: WallDate, n: number): WallDate {
  const dt = new Date(Date.UTC(w.y, w.m - 1, w.d + n));
  const wd = (w.weekday - 1 + (n % 7) + 7) % 7 + 1;
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), weekday: wd };
}

function fmtWall(w: WallDate): string {
  return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

export interface ParsedDue {
  kind: "relative";
  description: string;
  baseDate: string;
  date?: string | undefined;
  range?: { from: string; to: string } | undefined;
  ambiguous: boolean;
}

/**
 * Парсинг относительных сроков. base — момент сообщения (UTC), tz — IANA-зона
 * владельца. Поддержка: «завтра»/tomorrow/yarın; «к пятнице»/cuma/Friday;
 * «через N дней»/in N days/N gün sonra; «на следующей неделе»/next week/
 * gelecek hafta (диапазон + ambiguous).
 */
export function parseRelativeDue(text: string, base: Date, tz: string): ParsedDue | null {
  const t = text.toLowerCase();
  const w0 = wallDateOf(base, tz);
  const mk = (over: Partial<ParsedDue>): ParsedDue => ({
    kind: "relative",
    description: text.trim(),
    baseDate: fmtWall(w0),
    ambiguous: false,
    ...over,
  });

  if (/(завтра|tomorrow|yar[iı]n)/.test(t)) {
    return mk({ date: fmtWall(addDays(w0, 1)) });
  }

  const inDays = /через\s+(\d+)\s*(дн|дня|дней|day|days|g[uü]n)/.exec(t)
    ?? /in\s+(\d+)\s*days?/.exec(t)
    ?? /(\d+)\s*g[uü]n\s+sonra/.exec(t);
  if (inDays) {
    return mk({ date: fmtWall(addDays(w0, Number(inDays[1]))) });
  }

  if (/(следующей неделе|next week|gelecek hafta)/.test(t)) {
    const toMonday = (8 - w0.weekday) % 7 || 7; // строго следующий понедельник
    const mon = addDays(w0, toMonday);
    const sun = addDays(mon, 6);
    return mk({ range: { from: fmtWall(mon), to: fmtWall(sun) }, ambiguous: true });
  }

  const fri = /(к?\s*пятниц[еуа]|friday|cuma(ya)?\b)/.exec(t);
  if (fri) {
    let delta = (5 - w0.weekday + 7) % 7;
    if (delta === 0) {
      // Сегодня пятница — «к пятнице» неоднозначно: сегодня или через неделю.
      return mk({ range: { from: fmtWall(w0), to: fmtWall(addDays(w0, 7)) }, ambiguous: true });
    }
    return mk({ date: fmtWall(addDays(w0, delta)) });
  }

  return null;
}

export function detectPriority(text: string): TaskPriority {
  const t = text.toLowerCase();
  if (/(срочно|urgent|acil|asap|сегодня обязательно)/.test(t)) return "high";
  if (/(когда-нибудь|потом|low priority|önemsiz)/.test(t)) return "low";
  return "normal";
}

/* ---------- хранилище задач ---------- */

export class TaskStore {
  private tasks = new Map<string, Task>();
  private nextId = 1;

  /**
   * Создание/ревизия: если открытая задача с тем же (person, action, source)
   * уже есть — создаётся новая ВЕРСИЯ старой (prevVersionId), а не вторая задача.
   */
  upsert(input: {
    assignee: TaskAssignee;
    personId?: string | null;
    action: string;
    source: string;
    due?: DueDate | null;
    priority?: TaskPriority;
  }, at: Date = new Date()): Task {
    const existing = [...this.tasks.values()].find(
      (t) =>
        t.status === "open" &&
        t.assignee === input.assignee &&
        t.personId === (input.personId ?? null) &&
        t.action === input.action &&
        t.source === input.source,
    );
    if (existing) return this.revise(existing.id, input, at);

    const task: Task = {
      id: `task-${this.nextId++}`,
      assignee: input.assignee,
      personId: input.personId ?? null,
      action: input.action,
      source: input.source,
      due: input.due ?? null,
      priority: input.priority ?? "normal",
      status: "open",
      closeReason: null,
      closeRule: null,
      version: 1,
      prevVersionId: null,
      createdAt: at,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  revise(id: string, patch: Partial<Pick<Task, "action" | "due" | "priority" | "source">>, at: Date = new Date()): Task {
    const prev = this.mustGet(id);
    const next: Task = {
      ...prev,
      id: `task-${this.nextId++}`,
      action: patch.action ?? prev.action,
      due: patch.due !== undefined ? patch.due : prev.due,
      priority: patch.priority ?? prev.priority,
      source: patch.source ?? prev.source,
      version: prev.version + 1,
      prevVersionId: prev.id,
      createdAt: at,
    };
    prev.status = "cancelled"; // старая версия закрыта, не удалена
    prev.closeReason = `superseded by ${next.id}`;
    this.tasks.set(next.id, next);
    return next;
  }

  /**
   * Закрытие. Автоматическое — только с явным правилом (closeRule
   * 'explicit-auto'); иначе ручное. Ручное переживает повторный анализ:
   * close() по уже закрытой задаче — no-op, анализ не сбрасывает.
   */
  close(id: string, reason: string, by: "owner" | "auto-explicit", at: Date = new Date()): Task {
    const task = this.mustGet(id);
    void at;
    if (task.status !== "open") return task; // idempotent: повторный анализ не открывает
    task.status = "done";
    task.closeReason = reason;
    task.closeRule = by === "owner" ? "manual" : "explicit-auto";
    return task;
  }

  cancel(id: string, reason: string): Task {
    const task = this.mustGet(id);
    if (task.status !== "open") return task;
    task.status = "cancelled";
    task.closeReason = reason;
    return task;
  }

  /** Анализ не может закрыть задачу без явного правила (AT-18). */
  analysisSuggestsDone(id: string, _evidence: string): Task {
    return this.mustGet(id); // no-op: «выполнение не подтверждено»
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  all(): Task[] {
    return [...this.tasks.values()];
  }

  private mustGet(id: string): Task {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`unknown task: ${id}`);
    return t;
  }
}
