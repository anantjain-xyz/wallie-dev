-- Column-level grants must preserve the route's nonblank-title invariant even
-- when an authenticated member writes through PostgREST directly. NOT VALID
-- avoids rejecting legacy rows while still enforcing the check for new writes.
alter table public.sessions
  add constraint sessions_title_not_blank
  check (title ~ '[^[:space:]]') not valid;
