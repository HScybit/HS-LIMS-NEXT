'use client';

import { useEffect, useState } from 'react';
import DecisionRuleForm from './DecisionRuleForm.jsx';
import { apiRequest } from '../../lib/api-client.js';

function DecisionRuleView({ rule }) {
  const names = (rows, ids) => (rows ?? ids?.map((id) => ({ id })))?.map((row) => row.name ?? row.id).join(', ');
  const rows = [['Name', rule.name], ['Test Group', rule.isTestGroupParent ? `${rule.testGroupName} (${rule.testGroupUid})` : null],
    ['Parent Decision Rule', rule.parentDecisionRuleId ? rule.parentDecisionRuleName ?? rule.parentDecisionRuleId : null],
    ['Product', rule.productId ? rule.productName ?? rule.productId : null], ['Parameter', rule.testParameterId ? rule.parameterName ?? rule.testParameterId : null],
    ['MoA', rule.methodId ? rule.methodName ?? rule.methodId : null], ['Template', rule.templateId ? rule.templateName ?? rule.templateId : null],
    ['Sample Categories', names(rule.sampleCategories, rule.sampleCategoryIds)], ['Cut Off Value', rule.cutoffValue], ['Min', rule.minimum], ['Max', rule.maximum],
    ['UoM', rule.unitOfMeasure], ['Min Size', rule.minimumSize], ['Estimated Time in Days', rule.estimatedTimeInDays], ['Estimated Charges', rule.estimatedCharges],
    ['Express Time in Days', rule.expressTime], ['Express Charges', rule.expressCharges], ['Is NABL', rule.isNabl ? 'Yes' : 'No'],
    ['Discipline', rule.discipline], ['Group', rule.group], ['Unique Key', rule.uniqueKey], ['Instruments', names(rule.instruments, rule.instrumentIds)],
    ['Has Formula', rule.hasFormula ? 'Yes' : 'No'], ['Formula', rule.formula],
    ['Formula Variables', rule.formulaVariables?.map((variable) => `${variable.key} (${variable.label})`).join(', ')],
    ['Has Derived Formula', rule.hasDerivedFormula ? 'Yes' : 'No'], ['Custom Formula', rule.customFormula],
    ['Limits', rule.limits?.map((limit) => `${limit.lowerLimit ?? ''}..${limit.upperLimit ?? ''} → ${limit.outcome}`).join('; ')]];
  return <div className="container-fluid py-4"><div className="card border-0 shadow-sm"><div className="card-body p-4">
    <div className="table-responsive"><table className="table table-sm table-striped table-hover align-middle mb-0 table-bordered"><tbody>
      {rows.filter(([, value]) => value != null && value !== '').map(([label, value]) => <tr key={label}>
        <td className="text-muted fw-semibold py-2 px-3 w-25">{label}</td><td className="py-2 px-3"><div className="text-break">{value}</div></td>
      </tr>)}
    </tbody></table></div>
  </div></div></div>;
}

export default function DecisionRulePage({ ruleId, mode, canManage }) {
  const [rule, setRule] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const permitted = mode === 'view' || canManage;
  useEffect(() => {
    if (!ruleId || !permitted) return undefined;
    const controller = new AbortController();
    apiRequest(`/api/masters/decision-rules/${ruleId}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setRule(value); setError(''); } })
      .catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [ruleId, permitted, reload]);
  if (!permitted) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">You do not have permission to manage Decision Rules.</div></div>;
  if (error) return <div className="container-fluid py-4"><div className="alert alert-warning" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload(value => value + 1)}>Retry</button></div></div>;
  if (!ruleId) return <DecisionRuleForm />;
  if (!rule) return <div className="container-fluid py-4"><div className="text-muted" role="status">Loading Decision Rule...</div></div>;
  return mode === 'view' ? <DecisionRuleView rule={rule} /> : <DecisionRuleForm key={rule.id} rule={rule} />;
}
