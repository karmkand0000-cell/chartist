import { db } from '../db.js';
export async function audit(actor, action, entity, entityId, data, ip, h = db) {
  await h.query('insert into audit_log(actor_id, actor_role, action, entity, entity_id, data, ip) values ($1,$2,$3,$4,$5,$6,$7)',
    [actor?.id || null, actor?.role || 'system', action, entity || null, entityId != null ? String(entityId) : null, data ? JSON.stringify(data) : null, ip || null]);
}
export async function notify(userId, title, body, h = db) {
  await h.query('insert into notifications(user_id, title, body) values ($1,$2,$3)', [userId, title, body || null]);
}
