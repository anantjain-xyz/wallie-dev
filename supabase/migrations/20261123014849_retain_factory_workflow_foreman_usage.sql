-- A private retry journal for measured usage when native settlement is unavailable.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('factory-workflow-usage-recovery', 'factory-workflow-usage-recovery', false, 8192, array['text/plain']);
