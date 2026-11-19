-- Reporters use the existing scoped credential and admission. This scope can
-- only record deployment evidence, even when it is the token's sole permission.
alter type public.factory_command_scope add value 'deployments:observe';
