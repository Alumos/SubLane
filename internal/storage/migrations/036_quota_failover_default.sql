-- Quota failover becomes the default: existing groups opt in; new groups are created with it (CreateGroup).
UPDATE account_groups SET quota_failover = 1;
