CREATE FUNCTION template_require_value_actor() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF session_user='sampleify_app' AND (NEW.saved_by,NEW.saved_at) IS DISTINCT FROM
    (nullif(current_setting('app.user_id',true),'')::uuid,transaction_timestamp()) THEN
    RAISE EXCEPTION 'Saved values require the actual actor and transaction time' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capture_value_actor_guard BEFORE INSERT ON template_values
  FOR EACH ROW EXECUTE FUNCTION template_require_value_actor();
