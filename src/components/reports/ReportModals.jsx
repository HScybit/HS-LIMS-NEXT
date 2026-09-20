'use client';

import { Fragment, useState } from 'react';
import Modal from '../ui/Modal.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import InputFieldDropdown from '../ui/InputFieldDropdown.jsx';
import { printSettingsInput } from '../../reports/input.js';
import '../../styles/coa-modals.scss';

function CheckboxRow({ checked, label, onChange }) {
  return <label className="coa-checkbox-row"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} /><span>{label}</span></label>;
}

export function ParameterSelectionModal({ products, selectedIds, onClose, onSave }) {
  const [selected, setSelected] = useState(() => new Set(selectedIds));
  return <Modal open title="Select Parameters" titleIcon="file-text" size="xl" className="coa-modal coa-modal--parameters" bodyClassName="coa-modal__body coa-modal__body--parameters" actionsClassName="coa-modal__footer" onClose={onClose}
    actions={<div className="coa-modal-actions"><SecondaryButton onClick={onClose}>Close</SecondaryButton><PrimaryButton disabled={!selected.size} onClick={() => onSave([...selected])}>Save</PrimaryButton></div>}>
    <div className="coa-modal-toolbar"><SecondaryButton size="medium" onClick={() => setSelected(new Set(products.flatMap((product) => product.tests.map((test) => test.id))))}>Select All</SecondaryButton><SecondaryButton size="medium" tone="danger" onClick={() => setSelected(new Set())}>Clear All</SecondaryButton></div>
    <div className="coa-parameter-groups">{products.map((product) => <section className="coa-parameter-group" key={product.id}><h3>{product.name}</h3><div className="coa-parameter-list">
      {product.tests.map((test) => <CheckboxRow key={test.id} checked={selected.has(test.id)} label={[test.parameterName, test.methodName].filter(Boolean).join(' — ') || test.id}
        onChange={(checked) => setSelected((current) => { const next = new Set(current); if (checked) next.add(test.id); else next.delete(test.id); return next; })} />)}
    </div></section>)}</div>
  </Modal>;
}

export function PrintConfigModal({ config, onClose, onSave }) {
  const [settings, setSettings] = useState(config); const [error, setError] = useState('');
  const set = (key, value) => setSettings((current) => ({ ...current, [key]: value }));
  function submit() { try { onSave(printSettingsInput(settings)); } catch (failure) { setError(failure.message); } }
  return <Modal open title="Config Sample" titleIcon="edit" size="xl" className="coa-modal coa-modal--print-config" bodyClassName="coa-modal__body coa-modal__body--print-config" actionsClassName="coa-modal__footer" onClose={onClose}
    actions={<div className="coa-modal-actions"><SecondaryButton onClick={onClose}>Close</SecondaryButton><PrimaryButton onClick={submit}>Submit</PrimaryButton></div>}>
    {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}<div className="coa-config-grid">
      <label className="coa-form-field"><span>Page Size</span><InputFieldDropdown value={settings.pageSize} options={['A3', 'A4', 'A5', 'Letter', 'Legal'].map((value) => ({ value, label: value }))} onChange={(event) => set('pageSize', event.target.value)} /></label>
      <label className="coa-form-field"><span>Scaling Factor</span><input type="number" min="0.1" max="1" step="any" value={settings.scale} onChange={(event) => set('scale', event.target.value)} /></label>
      {['top', 'bottom'].map((side) => {
        const title = side === 'top' ? 'Top' : 'Bottom'; const custom = `useCustom${title}Margin`;
        return <Fragment key={side}><label className="coa-form-field"><span>{title} Margin</span><input type="number" min="0" max="500" step="any" disabled={!settings[custom]} value={settings[`${side}Margin`]} onChange={(event) => set(`${side}Margin`, event.target.value)} /></label>
          <CheckboxRow label={`Use Custom ${title} Margin?`} checked={settings[custom]} onChange={(checked) => set(custom, checked)} /></Fragment>;
      })}
      <label className="coa-form-field"><span>X-Axis Margin</span><input type="number" min="0" max="500" step="any" value={settings.xMargin} onChange={(event) => set('xMargin', event.target.value)} /></label>
      <div className="coa-config-checks">{[['isLandscape', 'Landscape'], ['printHeader', 'Print Header'], ['printFooter', 'Print Footer'], ['printWithoutSignature', 'Print without signature'], ['printWithoutImage', 'Print without image']].map(([key, label]) => <CheckboxRow key={key} label={label} checked={settings[key]} onChange={(checked) => set(key, checked)} />)}</div>
    </div>
  </Modal>;
}
