DROP TRIGGER api_keys_group_update;

-- Personal keys may change pools, but their workspace identity never changes.
CREATE TRIGGER api_keys_group_update BEFORE UPDATE OF group_id ON api_keys
WHEN (SELECT tenant_id FROM account_groups WHERE id=NEW.group_id)
     IS NOT (SELECT tenant_id FROM account_groups WHERE id=OLD.group_id)
BEGIN SELECT RAISE(ABORT, 'key_workspace_immutable'); END;
