BEGIN;
-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_merged_into_user_id_fkey" FOREIGN KEY ("merged_into_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_binding_requests" ADD CONSTRAINT "email_binding_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_contexts" ADD CONSTRAINT "merge_contexts_initiator_user_id_fkey" FOREIGN KEY ("initiator_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_contexts" ADD CONSTRAINT "merge_contexts_other_user_id_fkey" FOREIGN KEY ("other_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_merges" ADD CONSTRAINT "account_merges_initiator_user_id_fkey" FOREIGN KEY ("initiator_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_merges" ADD CONSTRAINT "account_merges_source_user_id_fkey" FOREIGN KEY ("source_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_merges" ADD CONSTRAINT "account_merges_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_record_mappings" ADD CONSTRAINT "merge_record_mappings_merge_id_fkey" FOREIGN KEY ("merge_id") REFERENCES "account_merges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
