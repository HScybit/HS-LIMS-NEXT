-- Cancellation retains the original cohort. Deleting unanswered or cancelled
-- assignments would silently change the meaning of historical quorum counts.
CREATE TRIGGER approval_case_retention BEFORE DELETE ON approval_cases FOR EACH ROW EXECUTE FUNCTION laboratory_append_only();
CREATE TRIGGER approval_stage_retention BEFORE DELETE ON approval_stages FOR EACH ROW EXECUTE FUNCTION laboratory_append_only();
CREATE TRIGGER approval_assignment_retention BEFORE DELETE ON approval_assignments FOR EACH ROW EXECUTE FUNCTION laboratory_append_only();
