import { randomUUID } from "node:crypto";
import type { Queryable } from "../dataSource.js";

/**
 * personsRepo: persist-слой persons/identities/person_links.
 * AT-02/AT-03: объединение возможно ТОЛЬКО через linkPersons с
 * confirmed=true; вызов без подтверждения бросает AutoMergeForbiddenError.
 * Создание person — только из подтверждённой идентичности (external_id),
 * никогда из отображаемого имени.
 */

export class AutoMergeForbiddenError extends Error {
  constructor() {
    super("Automatic merge is forbidden: owner confirmation (confirmed=true) is required");
    this.name = "AutoMergeForbiddenError";
  }
}

export interface PersonRow {
  id: string;
  displayName: string;
  ownerId: string;
}

export interface IdentityRow {
  id: string;
  personId: string;
  externalId: string;
  idScope: string;
  source: string;
  confirmed: boolean;
}

export async function createPerson(
  q: Queryable,
  ownerId: string,
  identity: { externalId: string; idScope: string; source: string },
  displayName: string,
): Promise<PersonRow> {
  const personId = randomUUID();
  await q.query(`INSERT INTO persons (id, owner_id, display_name) VALUES ($1, $2, $3)`, [
    personId,
    ownerId,
    displayName,
  ]);
  await addIdentity(q, personId, identity);
  return { id: personId, displayName, ownerId };
}

export async function addIdentity(
  q: Queryable,
  personId: string,
  identity: { externalId: string; idScope: string; source: string; confirmed?: boolean },
): Promise<IdentityRow> {
  const id = randomUUID();
  const confirmed = identity.confirmed ?? true;
  await q.query(
    `INSERT INTO identities (id, person_id, external_id, id_scope, source, confirmed)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id_scope, external_id)
     DO UPDATE SET person_id = excluded.person_id, confirmed = excluded.confirmed`,
    [id, personId, identity.externalId, identity.idScope, identity.source, confirmed],
  );
  return { id, personId, externalId: identity.externalId, idScope: identity.idScope, source: identity.source, confirmed };
}

/**
 * Подтверждение связи двух людей. confirmed=false — отказ с
 * AutoMergeForbiddenError (пишем unconfirmed-запись в журнал и отклоняем).
 */
export async function linkPersons(
  q: Queryable,
  aId: string,
  bId: string,
  opts: {
    action: "merge" | "split";
    confirmed: boolean;
    note?: string | undefined;
    identityId?: string | undefined;
  },
  at: Date = new Date(),
): Promise<{ linkId: string }> {
  const linkId = randomUUID();
  if (!opts.confirmed) {
    // Журналируем попытку, но не выполняем.
    await q.query(
      `INSERT INTO person_links (id, a_id, b_id, action, confirmed, note, created_at)
       VALUES ($1, $2, $3, $4, false, $5, $6)`,
      [linkId, aId, bId, opts.action, `rejected: no owner confirmation. ${opts.note ?? ""}`.trim(), at],
    );
    throw new AutoMergeForbiddenError();
  }
  await q.query(
    `INSERT INTO person_links (id, a_id, b_id, action, confirmed, note, created_at)
     VALUES ($1, $2, $3, $4, true, $5, $6)`,
    [linkId, aId, bId, opts.action, opts.note ?? null, at],
  );
  if (opts.action === "merge") {
    await q.query(`UPDATE identities SET person_id = $1 WHERE person_id = $2`, [aId, bId]);
  } else if (opts.identityId) {
    await q.query(`UPDATE identities SET person_id = $1 WHERE id = $2`, [bId, opts.identityId]);
  }
  return { linkId };
}

export async function getPerson(q: Queryable, personId: string): Promise<PersonRow | null> {
  const res = await q.query<PersonRow>(
    `SELECT id, display_name AS "displayName", owner_id AS "ownerId" FROM persons WHERE id = $1`,
    [personId],
  );
  return res.rows[0] ?? null;
}

export async function listIdentities(q: Queryable, personId: string): Promise<IdentityRow[]> {
  const res = await q.query<IdentityRow>(
    `SELECT id, person_id AS "personId", external_id AS "externalId",
            id_scope AS "idScope", source, confirmed
     FROM identities WHERE person_id = $1`,
    [personId],
  );
  return res.rows;
}

export async function linkLog(
  q: Queryable,
  personId: string,
): Promise<{ action: string; confirmed: boolean; note: string | null; createdAt: Date }[]> {
  const res = await q.query<{
    action: string;
    confirmed: boolean;
    note: string | null;
    createdAt: Date;
  }>(
    `SELECT action, confirmed, note, created_at AS "createdAt"
     FROM person_links WHERE a_id = $1 OR b_id = $1 ORDER BY created_at`,
    [personId],
  );
  return res.rows;
}
