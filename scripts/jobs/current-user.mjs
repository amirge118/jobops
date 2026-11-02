// The one place that decides whose data a request or a scan works on. There are
// no accounts yet, so it is always the local user; login replaces this function.
export const LOCAL_USER_ID = 1;

export function resolveCurrentUser() {
  return { id: LOCAL_USER_ID, isOwner: true };
}

// Shared sources run on the owner's accounts and network, so only the owner
// changes them; other users benefit from the jobs they bring in.
export function requireOwner(user) {
  if (!user.isOwner) throw Object.assign(new Error('Only the owner can change shared sources'), { statusCode: 403, code: 'owner_only' });
}
