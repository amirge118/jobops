// The one place that decides whose data a request or a scan works on. There are
// no accounts yet, so it is always the local user; login replaces this function.
export const LOCAL_USER_ID = 1;

export function resolveCurrentUser() {
  return { id: LOCAL_USER_ID };
}
