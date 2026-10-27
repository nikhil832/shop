import express from 'express';
import { z } from 'zod';
import { logActivity } from './activity.js';
import { HttpError, parse, parseObjectId } from './http.js';

// Staff accounts (stage 66): roles below admin. A packer ships orders; support answers customers. What each role may
// do is PERMISSIONS, the one list the server checks (requirePermission, and staffGuard for the admin router) and the
// admin panel shows tabs from (`toUser().permissions`). Anything not listed is for admins only, so a new admin route is
// closed to staff until it's added here. Admins grant and change staff roles on Admin → Staff; the admin role itself
// is only ever granted from the command line (`npm run make-admin`).

export const STAFF_ROLES = { packer: 'Packer', support: 'Support' };
export const PERMISSIONS = {
  admin: ['*'],
  packer: ['orders.view', 'orders.ship', 'orders.notes'],
  support: ['orders.view', 'orders.notes', 'reviews', 'questions', 'help'],
};

export const permissionsOf = (user) => PERMISSIONS[user?.role] ?? [];
export const can = (user, permission) => {
  const granted = permissionsOf(user);
  return granted.includes('*') || granted.includes(permission);
};
// Admins and staff: anyone who uses the admin panel.
export const isStaff = (user) => permissionsOf(user).length > 0;

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) throw new HttpError(401, 'Please log in');
    if (!can(req.user, permission)) {
      throw new HttpError(403, isStaff(req.user) ? "Your account can't do this" : 'Admins only');
    }
    next();
  };
}

export function requireStaff(req, res, next) {
  if (!req.user) throw new HttpError(401, 'Please log in');
  if (!isStaff(req.user)) throw new HttpError(403, 'Admins only');
  next();
}

// For a router whose routes all sit under /admin: the routes staff may use, as [method, path below /admin, permission].
// Every other request needs an admin ('*').
export function staffGuard(routes) {
  return (req, res, next) => {
    const found = routes.find(([method, path]) => method === req.method && path.test(req.path));
    return requirePermission(found ? found[2] : '*')(req, res, next);
  };
}

const roleBody = z.object({ role: z.enum([...Object.keys(STAFF_ROLES), 'user'], 'Choose a role') });
// The same email rule as signing up (routes/auth.js), kept here so this module imports nothing from auth: auth.js
// imports permissionsOf from it.
const addBody = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email('Enter a valid email')),
  role: z.enum(Object.keys(STAFF_ROLES), 'Choose a role'),
});

const toStaff = (u) => ({
  id: u._id.toString(),
  name: u.name,
  email: u.email,
  role: u.role,
  twoStep: Boolean(u.totp?.enabledAt),
});

export function staffRouter({ db }) {
  const users = db.collection('users');
  const router = express.Router();
  router.use('/admin/staff', requirePermission('*'));

  // Admins first, then staff by name.
  router.get('/admin/staff', async (req, res) => {
    const docs = await users
      .find({ role: { $in: Object.keys(PERMISSIONS) } }, { projection: { name: 1, email: 1, role: 1, totp: 1 } })
      .toArray();
    docs.sort((a, b) => (b.role === 'admin') - (a.role === 'admin') || a.name.localeCompare(b.name));
    res.json({ items: docs.map(toStaff), roles: STAFF_ROLES });
  });

  // Makes an existing customer account staff. Admins can't be changed here.
  router.post('/admin/staff', async (req, res) => {
    const { email, role } = parse(addBody, req.body);
    const before = await users.findOneAndUpdate(
      { email, role: { $ne: 'admin' } },
      { $set: { role } },
      { returnDocument: 'before' },
    );
    if (!before) {
      const admin = await users.findOne({ email, role: 'admin' }, { projection: { _id: 1 } });
      throw new HttpError(
        admin ? 409 : 404,
        admin ? 'That account is already an admin' : 'No account has that email. Ask them to sign up first.',
      );
    }
    if (before.role !== role) {
      await logActivity(db, req.user, {
        area: 'accounts',
        action: 'Made staff',
        target: { label: `${before.name} (${email})`, path: '/admin/staff' },
        changes: [{ field: 'Role', from: STAFF_ROLES[before.role] ?? 'Customer', to: STAFF_ROLES[role] }],
      });
    }
    res.status(201).json(toStaff({ ...before, role }));
  });

  // Changes a staff member's role, or makes them a customer again (`user`). Takes effect on their next request.
  router.patch('/admin/staff/:id', async (req, res) => {
    const _id = parseObjectId(req.params.id, 'account id');
    const { role } = parse(roleBody, req.body);
    const before = await users.findOneAndUpdate(
      { _id, role: { $in: Object.keys(STAFF_ROLES) } },
      { $set: { role } },
      { returnDocument: 'before' },
    );
    if (!before) {
      const doc = await users.findOne({ _id }, { projection: { role: 1 } });
      if (!doc) throw new HttpError(404, 'Account not found');
      throw new HttpError(409, doc.role === 'admin' ? "Admins can't be changed here" : "That account isn't staff");
    }
    if (before.role !== role) {
      await logActivity(db, req.user, {
        area: 'accounts',
        action: role === 'user' ? 'Removed from staff' : 'Changed staff role',
        target: { label: `${before.name} (${before.email})`, path: '/admin/staff' },
        changes: [{ field: 'Role', from: STAFF_ROLES[before.role], to: STAFF_ROLES[role] ?? 'Customer' }],
      });
    }
    res.json(toStaff({ ...before, role }));
  });

  return router;
}
