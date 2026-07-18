-- DELETE payloads need the prior row fields for clients whose initial RSC
-- snapshot predates the id-bearing realtime representation.
alter table public.session_artifacts replica identity full;
alter table public.session_phase_completions replica identity full;
