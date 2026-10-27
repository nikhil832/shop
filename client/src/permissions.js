// What the logged-in account may do in the admin panel (stage 66): `user.permissions` comes from the server
// (server/src/staff.js), ['*'] for admins. The server checks every request too; this only decides what to show.
export const can = (user, permission) =>
  Boolean(user?.permissions?.includes('*') || user?.permissions?.includes(permission));
export const isStaff = (user) => Boolean(user?.permissions?.length);
