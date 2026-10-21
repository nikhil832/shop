import { createContext, useContext, useState } from 'react';
import { useFetch } from './useFetch.js';

const AuthContext = createContext(null);

// `user` is undefined while the session is being checked, null when logged out.
export function AuthProvider({ children }) {
  // Set by login, register and logout; until one of those happens, use what /auth/me said.
  const [changed, setChanged] = useState();
  const { data, error } = useFetch('/auth/me');
  const user = changed !== undefined ? changed : data ? data.user : error ? null : undefined;
  return <AuthContext value={{ user, setUser: setChanged }}>{children}</AuthContext>;
}

export const useAuth = () => useContext(AuthContext);

// Where to go after logging in: only paths on this site.
export const safeNext = (next) => (/^\/(?![/\\])/.test(next ?? '') ? next : '/');
