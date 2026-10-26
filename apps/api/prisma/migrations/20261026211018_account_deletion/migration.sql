BEGIN;
ALTER TABLE users ADD COLUMN deletion_requested_at timestamptz(3);
UPDATE users SET deletion_requested_at=deletion_due_at-interval '7 days' WHERE deletion_due_at IS NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_deletion_window CHECK ((deletion_due_at IS NULL AND deletion_requested_at IS NULL) OR (status='pending_deletion' AND deletion_due_at=deletion_requested_at+interval '7 days'));
COMMIT;
