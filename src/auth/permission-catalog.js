// Every API permission code any src/ service actually calls requirePermission()
// with. Several of these (masters.*, templates.*, samples.*, datasheets.execute,
// test_requests.allocate, workflows.*, approvals.respond) are never inserted by
// any migration — only ever provisioned here — because a fresh organization has
// no bootstrapped role/permission grant of its own to seed the first one from.
export const PERMISSION_CATALOG = Object.freeze([
  ['masters.read', 'View master data'], ['masters.manage', 'Manage master data'],
  ['templates.read', 'View templates'], ['templates.manage', 'Manage templates'],
  ['samples.read', 'View samples'], ['samples.create', 'Create samples'], ['samples.manage', 'Manage samples'],
  ['datasheets.execute', 'Enter datasheet results'],
  ['test_requests.allocate', 'Allocate test requests'],
  ['workflows.read', 'View workflows'], ['workflows.manage', 'Manage workflows'],
  ['approvals.respond', 'Respond to workflow approvals'],
  ['roles.read', 'View roles'], ['roles.manage', 'Manage roles'],
  ['users.read', 'View users'], ['users.manage', 'Manage users'],
  ['checklists.read', 'View checklists'], ['checklists.manage', 'Manage checklists'],
  ['settings.read', 'View organization settings'], ['settings.manage', 'Manage organization settings'],
  ['report_settings.read', 'View report settings'], ['report_settings.manage', 'Manage report settings'],
  ['compliance.read', 'View compliance records'], ['compliance.manage', 'Manage compliance records'],
  ['instruments.read', 'View instruments'], ['instruments.manage', 'Manage instruments'],
  ['instrument_services.manage', 'Manage instrument service logs'],
  ['leave_records.read', 'View leave records'], ['leave_records.manage', 'Manage leave records'],
  ['environment_data.read', 'View environmental monitoring data'], ['environment_data.manage', 'Manage environmental monitoring data'],
  ['training.read', 'View training records'], ['training.manage', 'Manage training records'],
  ['assessments.read', 'View assessments'], ['assessments.manage', 'Manage assessments'], ['assessments.take', 'Take assessments'],
  ['documents.read', 'View documents'], ['documents.manage', 'Manage documents'],
  ['dynamic_apis.read', 'View dynamic APIs'], ['dynamic_apis.manage', 'Manage dynamic APIs'],
]);
