-- Commit the values before the next migration uses them in constraints.
alter type public.connector_provider add value 'slack';
alter type public.connector_resource_kind add value 'channel';
