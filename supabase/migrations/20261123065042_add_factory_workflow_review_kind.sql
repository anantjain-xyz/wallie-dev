-- Apply before the functions and triggers that use the new enum value.
alter type internal.factory_workflow_node_kind add value 'review';
