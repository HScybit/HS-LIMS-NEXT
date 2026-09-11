'use client';

import AppIcon from '../ui/AppIcon.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import { SampleTextField, SampleSelectField, optionList } from './SampleFormFields.jsx';
import { newTest, productParameters, availableMethods, estimatedAmount, testSelection } from '../../samples/form.js';

export default function SampleProductCard({ product, index, kind, currency, options, disabled, onChange, onRemove }) {
  const categoryProducts = options.products.filter((item) => item.sampleCategoryIds.includes(product.sampleCategoryId));
  const categoryTags = new Set(categoryProducts.flatMap((item) => item.tagIds));
  const products = categoryProducts.filter((item) => !product.tagId || item.tagIds.includes(product.tagId));
  const parameters = productParameters(options, product);
  const required = kind !== 'complaint' || product.tests.some((test) => test.isRetest);
  const updateTest = (key, changes) => onChange({ tests: product.tests.map((test) => test.key === key ? { ...test, ...changes } : test) });
  const selectTest = (test, parameterId, methodId) => updateTest(test.key, testSelection(options, product, parameterId, methodId));
  const textField = (key, label, props = {}) => <SampleTextField label={label} value={product[key]} disabled={disabled} onChange={(value) => onChange({ [key]: value })} {...props} />;
  return <div className={index > 0 ? 'border-top pt-4' : ''}>
    <div className="d-flex align-items-center justify-content-between gap-3 mb-4">
      <div className="d-inline-flex align-items-center gap-2 h5 fw-semibold text-body mb-0">
        <span className="smplfy-badge badge text-bg-primary rounded-circle d-inline-flex align-items-center justify-content-center">{index + 1}</span><span>Product {index + 1}</span>
      </div>
      <button type="button" className="smplfy-btn btn btn-outline-danger btn-sm" aria-label="Remove product" disabled={disabled} onClick={onRemove}><AppIcon name="trash" /></button>
    </div>
    <div className="row g-4">
      <div className="col-lg-6"><SampleSelectField label="Category" required={required} value={product.sampleCategoryId} options={optionList(options.sampleCategories)} placeholder="Select sample category" disabled={disabled}
        onChange={(value) => onChange({ sampleCategoryId: value, productId: '', tagId: '', tests: [newTest()] })} /></div>
      <div className="col-lg-6"><SampleSelectField label="Tag" value={product.tagId} options={optionList(options.tags.filter((tag) => categoryTags.has(tag.id)))}
        placeholder={!product.sampleCategoryId ? 'Select category first' : !categoryTags.size ? 'No tags for this category' : 'Filter by tag (optional)'} disabled={disabled || !product.sampleCategoryId}
        onChange={(value) => onChange({ tagId: value, productId: '', tests: [newTest()] })} /></div>
      <div className="col-lg-6"><SampleSelectField label="Product" required={required} value={product.productId} options={optionList(products)}
        placeholder={!product.sampleCategoryId ? 'Select category first' : !product.tagId ? 'Select tag first or select directly' : !products.length ? 'No products match selected tag' : 'Select product'}
        disabled={disabled || !product.sampleCategoryId} onChange={(value) => onChange({ productId: value, tests: [newTest()] })} /></div>
      <div className="col-12">{textField('description', 'Description', { textarea: true, rows: 2, placeholder: 'Sample Description', maxLength: 2000 })}</div>
      <div className="col-lg-6">{textField('quantity', 'Quantity', { type: 'number', step: 'any', min: '0', required, placeholder: '0' })}</div>
      <div className="col-lg-6"><div className="smplfy-form-field"><div className="smplfy-form-label-row"><label className="smplfy-form-label form-label" htmlFor={`${product.key}-size`}>Sample Size</label></div>
        <div className="sample-form-size-grid">{textField('sampleSize', null, { id: `${product.key}-size`, placeholder: 'Value', maxLength: 120 })}
          <SampleSelectField value={product.measurementUnitId} options={optionList(options.measurementUnits)} placeholder="Unit" aria-label="Sample size unit" disabled={disabled} onChange={(value) => onChange({ measurementUnitId: value })} />
        </div></div></div>
      <div className="col-lg-6">{textField('quality', 'Quality', { placeholder: 'Quality of sample', maxLength: 200 })}</div>
      <div className="col-lg-6">{textField('identificationMark', 'Identification Mark', { placeholder: 'if any', maxLength: 250 })}</div>
      <div className="col-lg-6">{textField('condition', 'Condition', { placeholder: 'eg. good, fair', maxLength: 250 })}</div>
    </div>
    <div className="d-flex align-items-center justify-content-between gap-3 mt-4 mb-3 flex-wrap">
      <h3 className="h5 fw-semibold text-body mb-0">Parameter Data</h3>
      <div className="d-flex align-items-center gap-3 flex-wrap"><div className="small text-muted">Amount: <strong>{currency === 'INR' ? '₹' : `${currency} `}{estimatedAmount([product], kind).toFixed(2)}</strong></div>
        <button type="button" className="smplfy-btn btn btn-link p-0 text-decoration-underline" disabled={disabled || !product.productId || !parameters.length}
          onClick={() => onChange({ tests: parameters.map((parameter) => ({ ...newTest(), ...testSelection(options, product, parameter.id) })) })}>Auto-fill parameters</button>
      </div>
    </div>
    <div className="table-responsive sample-form-validation-group">
      <table className="smplfy-table table table-borderless align-middle mb-0"><thead><tr>
        {kind === 'complaint' ? <th className="text-center" scope="col">Retest</th> : null}
        <th scope="col">Parameter <span className="text-danger">*</span></th><th scope="col">Test Method <span className="text-danger">*</span></th>
        <th scope="col">Req. Size</th><th scope="col">Charges</th><th scope="col">Est. Time</th><th className="text-end" scope="col">Action</th>
      </tr></thead><tbody>{product.tests.map((test, testIndex) => <tr key={test.key}>
        {kind === 'complaint' ? <td className="text-center align-middle"><Checkbox checked={test.isRetest} ariaLabel={`Retest parameter ${testIndex + 1}`} disabled={disabled} onChange={(value) => updateTest(test.key, { isRetest: value })} /></td> : null}
        <td className="sample-form-parameter-table__cell--parameter"><div className="sample-form-parameter-field">
          <SampleSelectField value={test.testParameterId} options={optionList(parameters)} placeholder="Select parameter…" aria-label={`Parameter ${testIndex + 1}`}
            required={kind !== 'complaint' || test.isRetest} disabled={disabled || !product.productId} onChange={(value) => selectTest(test, value)} />
          <span className={`badge sample-form-nabl-badge ${test.isAccredited ? 'text-bg-success' : 'text-bg-secondary'}`} title="Accreditation from the selected decision rule">{test.isAccredited ? 'NABL' : 'Non NABL'}</span>
        </div></td>
        <td className="sample-form-parameter-table__cell--wide"><SampleSelectField value={test.methodId} options={optionList(availableMethods(options, product, test.testParameterId))} placeholder="Test method…"
          aria-label={`Test method ${testIndex + 1}`} required={kind !== 'complaint' || test.isRetest} disabled={disabled || !test.testParameterId} onChange={(value) => selectTest(test, test.testParameterId, value)} /></td>
        <td className="sample-form-parameter-table__cell--compact"><SampleTextField value={test.requestedSize} aria-label={`Requested size ${testIndex + 1}`} placeholder="—" maxLength={150} disabled={disabled} onChange={(value) => updateTest(test.key, { requestedSize: value })} /></td>
        <td className="sample-form-parameter-table__cell--compact"><SampleTextField type="number" min="0" step="any" value={test.rate} aria-label={`Charges ${testIndex + 1}`} placeholder={currency === 'INR' ? '₹' : currency} disabled={disabled} onChange={(value) => updateTest(test.key, { rate: value })} /></td>
        <td className="sample-form-parameter-table__cell--tiny"><SampleTextField type="number" min="0" step="any" value={test.estimatedDurationDays} aria-label={`Estimated days ${testIndex + 1}`} placeholder="days" disabled={disabled} onChange={(value) => updateTest(test.key, { estimatedDurationDays: value })} /></td>
        <td className="text-end align-middle"><button type="button" className="smplfy-btn btn btn-outline-danger btn-sm" aria-label="Remove parameter" disabled={disabled} onClick={() => onChange({ tests: product.tests.filter((item) => item.key !== test.key) })}><AppIcon name="trash" /></button></td>
      </tr>)}</tbody></table>
      <button className="smplfy-btn btn btn-outline-secondary w-100 mt-2" type="button" disabled={disabled || product.tests.length >= 1000}
        onClick={() => onChange({ tests: [...product.tests, newTest()] })}><AppIcon name="plus" /><span>Add New Parameter</span></button>
    </div>
  </div>;
}
