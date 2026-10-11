/**
 * Persons: объединение/разделение людей ТОЛЬКО с подтверждением владельца (AT-02).
 * Одинаковые имена никогда не объединяются автоматически — только явная
 * подтверждённая связь. Все действия пишутся в журнал связей (split_log).
 */

export class PersonLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonLinkError";
  }
}

export interface Person {
  id: string;
  displayName: string;
  identityIds: string[];
}

export interface PersonLink {
  aId: string;
  bId: string;
  confirmed: boolean;
  at: Date;
  note: string;
}

export interface SplitLogEntry {
  personId: string;
  identityId: string;
  at: Date;
  reason: string;
}

export class PersonStore {
  private persons = new Map<string, Person>();
  private byIdentity = new Map<string, string>(); // identityId -> personId
  private nextId = 1;
  readonly linkLog: PersonLink[] = [];
  readonly splitLog: SplitLogEntry[] = [];

  /** Создать человека из подтверждённой идентичности (не по имени!). */
  createPerson(identityId: string, displayName: string): Person {
    if (this.byIdentity.has(identityId)) {
      return this.persons.get(this.byIdentity.get(identityId) as string) as Person;
    }
    const person: Person = {
      id: `p${this.nextId++}`,
      displayName,
      identityIds: [identityId],
    };
    this.persons.set(person.id, person);
    this.byIdentity.set(identityId, person.id);
    return person;
  }

  get(personId: string): Person | undefined {
    return this.persons.get(personId);
  }

  findByIdentity(identityId: string): Person | undefined {
    const pid = this.byIdentity.get(identityId);
    return pid ? this.persons.get(pid) : undefined;
  }

  /** Поиск по имени — только подсказка, НИЧЕГО не объединяет. */
  findByName(name: string): Person[] {
    const needle = name.trim().toLowerCase();
    return [...this.persons.values()].filter(
      (p) => p.displayName.trim().toLowerCase() === needle,
    );
  }

  /**
   * Объединить двух людей. Требует confirmed=true — подтверждение владельца.
   * Автоматическое объединение запрещено: confirmed=false бросает ошибку.
   */
  merge(aId: string, bId: string, confirmed: boolean, at: Date = new Date(), note = ""): Person {
    if (!confirmed) {
      throw new PersonLinkError("Automatic merge is forbidden: owner confirmation required");
    }
    const a = this.persons.get(aId);
    const b = this.persons.get(bId);
    if (!a || !b) throw new PersonLinkError("merge: unknown person id");
    if (aId === bId) return a;
    for (const identityId of b.identityIds) {
      if (!a.identityIds.includes(identityId)) a.identityIds.push(identityId);
      this.byIdentity.set(identityId, a.id);
    }
    this.persons.delete(bId);
    this.linkLog.push({ aId: a.id, bId: bId, confirmed: true, at, note });
    return a;
  }

  /**
   * Разделить: отсоединить конкретную identityId от человека в нового человека.
   * Только с подтверждением владельца; запись идёт в split_log.
   */
  split(personId: string, identityId: string, reason: string, at: Date = new Date()): Person {
    const person = this.persons.get(personId);
    if (!person) throw new PersonLinkError("split: unknown person id");
    if (!person.identityIds.includes(identityId)) {
      throw new PersonLinkError(`split: identity ${identityId} not attached to ${personId}`);
    }
    if (person.identityIds.length === 1) {
      throw new PersonLinkError("split: cannot split the last identity of a person");
    }
    person.identityIds = person.identityIds.filter((i) => i !== identityId);
    const newPerson: Person = {
      id: `p${this.nextId++}`,
      displayName: person.displayName,
      identityIds: [identityId],
    };
    this.persons.set(newPerson.id, newPerson);
    this.byIdentity.set(identityId, newPerson.id);
    this.splitLog.push({ personId, identityId, at, reason });
    return newPerson;
  }

  count(): number {
    return this.persons.size;
  }

  all(): Person[] {
    return [...this.persons.values()];
  }
}
