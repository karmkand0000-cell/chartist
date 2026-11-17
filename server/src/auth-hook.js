import { verifyAccess } from './services/auth.js';
import { unauth, forbidden } from './errors.js';
export async function authenticate(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) throw unauth();
  req.user = await verifyAccess(token);
}
export const requireRole = (...roles) => async (req) => {
  await authenticate(req);
  if (!roles.includes(req.user.role)) throw forbidden('Insufficient permissions');
};
