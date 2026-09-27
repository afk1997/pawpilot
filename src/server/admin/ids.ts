/** A conversation id as the admin routes take it: a uuid. Anything else is refused before it reaches Postgres, which would fail on it. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
