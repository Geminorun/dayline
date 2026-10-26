BEGIN;
ALTER TABLE qr_requests DROP CONSTRAINT qr_requests_purpose_check;
ALTER TABLE qr_requests ADD CONSTRAINT qr_requests_purpose_check CHECK (purpose IN ('login', 'bind_wechat', 'reauth'));
ALTER TABLE email_binding_requests ADD CONSTRAINT email_binding_requests_status_check CHECK (status IN ('pending','verified','consumed','cancelled'));
ALTER TABLE account_merges ADD CONSTRAINT account_merges_status_check CHECK (status IN ('preview','committed','cancelled','expired'));
ALTER TABLE account_merges ADD CONSTRAINT account_merges_distinct_users_check CHECK (source_user_id <> target_user_id);
ALTER TABLE merge_contexts ADD CONSTRAINT merge_contexts_distinct_users_check CHECK (initiator_user_id <> other_user_id);
CREATE INDEX users_merged_into_user_id_idx ON users(merged_into_user_id);
COMMIT;
