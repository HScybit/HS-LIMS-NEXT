// Admin Hub link registry. Section titles, grouping and labels follow the
// source Meteor Admin Hub (imports/ui/pages/adminHub) exactly, mirrored again
// in the PERN app (apps/web/src/adminHub/adminHubLinks.js) with the same
// structure. A link's `path` is set only when the page actually exists in
// this codebase; unbuilt links stay `available: false`, matching PERN's own
// "not yet ported" treatment rather than inventing pages ahead of scope.
// Add a path here only once its page is actually built — do not add new
// labels/sections beyond what the two source apps define.
const rawSections = [
  { title: 'Modules', icon: 'admin-modules', links: [
    ['Feedback', null],
    ['Document Category', null],
    ['Test Plans Management', null],
    ['Training Schedule', null],
  ] },
  { title: 'Personnel & Hierarchy', icon: 'admin-personnel', links: [
    ['Lab Management', '/lab_management'],
    ['User Management', '/user_management'],
    ['Role Management', '/role_management'],
  ] },
  { title: 'Master Data', icon: 'master-data', links: [
    ['Sample Category', '/sample_categories'],
    ['Discipline', null],
    ['Product Management', '/products'],
    ['Parameter Management', '/test_parameters'],
    ['MoA Management', '/method_of_analysis'],
    ['UoM Management', null],
    ['Decision Rule Management', '/decision_rules'],
    ['NABL Certificates', '/nabl_certificates'],
    ['Leave Records', null],
    ['Environment Data', null],
  ] },
  { title: 'System Settings', icon: 'system-settings', links: [
    ['Organization Settings', '/organization_settings'],
    ['Data Transfer', null],
    ['Custom Css', '/custom_css'],
    ['Workflow Management', '/workflow_management'],
    ['Template Management', '/master_template_management'],
    ['Header Management', '/header_management'],
    ['Footer Management', '/footer_management'],
    ['Watermark Report', '/watermark_report'],
    ['Instrument Files', null],
  ] },
  { title: 'Configurations', icon: 'admin-configurations', links: [
    ['Dashboard Management', null],
    ['Email Management', null],
    ['Custom Fields', '/project_fields'],
    ['Tag Master Management', null],
    ['Checklists Management', '/checklists'],
    ['Data Master', null],
    ['Custom Forms', null],
  ] },
  { title: 'ELN Management', icon: 'admin-eln', links: [
    ['Constants Master', null],
    ['Expenditure Master', null],
    ['Unit Management', '/unit_management'],
    ['Category Management', null],
    ['Stage Management', null],
    ['Critical Spec Master', null],
    ['Rationale Management', null],
  ] },
];

export const adminHubSections = Object.freeze(rawSections.map((section) => ({
  ...section,
  links: Object.freeze(section.links.map(([label, path]) => Object.freeze({ label, path, available: Boolean(path) }))),
})));

// Column layout for the module grid, matching both source apps exactly.
export const adminHubGridColumns = Object.freeze([
  ['Modules', 'Configurations'],
  ['Personnel & Hierarchy', 'ELN Management'],
  ['Master Data'],
  ['System Settings'],
]);
