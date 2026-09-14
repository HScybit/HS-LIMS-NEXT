import { randomUUID } from 'node:crypto';
import { loadTestParameter, saveTestParameter } from '../../src/masters/test-parameters.js';
import { prepareReportFlow } from './report-flow.js';

export const trScientificMarkup = '<strong>Water H<sub>2</sub>O</strong> &amp; x<sup>2</sup> = 0';

export async function renameTrParameter(client, identity, id, name) {
  const current = await loadTestParameter(client, identity, id);
  return saveTestParameter(client, identity, { id, requestId: randomUUID(), revision: current.revision, name,
    description: current.description, key: current.key, schemeAbbreviation: current.schemeAbbreviation,
    order: current.order, laboratoryId: current.laboratoryId, measurementUncertainty: current.measurementUncertainty });
}

export function prepareTrDataDisplayFlow(owner, account, { name = trScientificMarkup, complete = true } = {}) {
  return prepareReportFlow(owner, account, { finalSection: true, finalContext: true, complete,
    prepareProduct: (client, identity, fixture) => renameTrParameter(client, identity, fixture.parameter.id, name) });
}
