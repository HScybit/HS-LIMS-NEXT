export async function insertDatasheetSubjects(client, identity, datasheetId, capture) {
  if (!capture.subjectBindings?.length) return;
  await client.query(`INSERT INTO datasheet_subjects(organization_id,datasheet_id,instance_id,version_id,occurrence_id,test_request_id,specification_id,created_revision,created_by)
    SELECT $1,$2,$3,$4,binding.occurrence_id,binding.test_request_id,binding.specification_id,$5,$6
    FROM unnest($7::uuid[],$8::uuid[],$9::uuid[]) binding(occurrence_id,test_request_id,specification_id)`,
  [identity.organization_id, datasheetId, capture.instanceId, capture.versionId, capture.revision, identity.user_id,
    capture.subjectBindings.map((binding) => binding.occurrenceId), capture.subjectBindings.map((binding) => binding.testRequestId), capture.subjectBindings.map((binding) => binding.specificationId)]);
}
