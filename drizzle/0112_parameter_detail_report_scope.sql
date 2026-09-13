-- Scalar job submissions reference the shared summary capture, but a scalar
-- report never renders its cached Detail values. Allow only the actual final
-- section's selected specification. Array items inherit this parent policy.
ALTER POLICY parameter_detail_worker_read ON template_values USING
  (value_type<>'parameter_detail' OR EXISTS (SELECT 1 FROM sample_report_tests chosen JOIN datasheet_submissions submission
    ON submission.organization_id=chosen.organization_id AND submission.id=chosen.submission_id
    WHERE chosen.organization_id=template_values.organization_id AND chosen.report_id=(SELECT report_id FROM laboratory_parameter_context_scope())
      AND submission.source='section' AND chosen.specification_id=template_values.parameter_detail_specification_id
      AND submission.instance_id=template_values.instance_id AND template_values.revision<=submission.capture_revision));
