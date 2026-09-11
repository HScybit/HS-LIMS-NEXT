-- Explicit row locks require UPDATE privilege. These fixed integrity triggers
-- must lock an immutable specification while ordinary application users retain
-- no UPDATE grant on its history. All queries already use a fixed search_path
-- and the enclosing row's organization; the caller's write RLS still applies.
ALTER FUNCTION laboratory_guard_specification_limit() SECURITY DEFINER;
ALTER FUNCTION laboratory_guard_test_request() SECURITY DEFINER;
ALTER FUNCTION laboratory_guard_datasheet() SECURITY DEFINER;
