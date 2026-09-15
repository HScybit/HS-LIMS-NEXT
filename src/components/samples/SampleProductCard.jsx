'use client';

import { memo } from 'react';
import AppIcon from '../ui/AppIcon.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import { SampleTextField, SampleSelectField, optionList } from './SampleFormFields.jsx';
import { newTest, productParameters, availableMethods, estimatedAmount, testSelection } from '../../samples/form.js';
import { retainedSampleOption } from '../../samples/edit-form.js';
import SampleImageField from './SampleImageField.jsx';

const testInUse = test => Boolean(test.requestId || (test.status && test.status !== 'planned'));

export default memo(function SampleProductCard({ product, index, kind, currency, options, disabled, onChange: updateProduct, onRemove: removeProduct, savedProduct, onImageBusy, canEditRetest = false }) {
  const onChange = changes => updateProduct(product.key, changes);
  const onRemove = () => removeProduct(product.key);
  const categoryProducts = options.products.filter((item) => item.sampleCategoryIds.includes(product.sampleCategoryId));
  const categoryTags = new Set(categoryProducts.flatMap((item) => item.tagIds));
  const products = categoryProducts.filter((item) => !product.tagId || item.tagIds.includes(product.tagId));
  const parameters = productParameters(options, product);
  const used = Boolean(savedProduct?.tests.some(testInUse));
  const savedTests = new Map((savedProduct?.tests ?? []).map(test => [test.id, test]));
  const sameContext = savedProduct?.productId === product.productId && savedProduct?.sampleCategoryId === product.sampleCategoryId;
  const categoryOptions = retainedSampleOption(optionList(options.sampleCategories), product.sampleCategoryId, savedProduct?.sampleCategoryId, savedProduct?.categoryName);
  const productOptions = retainedSampleOption(optionList(products), product.productId,
    savedProduct?.sampleCategoryId === product.sampleCategoryId ? savedProduct?.productId : null, savedProduct?.productName);
  const tagOptions = retainedSampleOption(optionList(options.tags.filter(tag => categoryTags.has(tag.id))), product.tagId, sameContext ? savedProduct?.tagId : null, savedProduct?.tag);
  const unitOptions = retainedSampleOption(optionList(options.measurementUnits), product.measurementUnitId, savedProduct?.measurementUnitId, savedProduct?.unitSymbol || savedProduct?.unitCode);
  const required = kind !== 'complaint' || product.tests.some((test) => test.isRetest);
  const updateTest = (key, changes) => onChange({ tests: product.tests.map((test) => test.key === key ? { ...test, ...changes } : test) });
  const selectTest = (test, parameterId, methodId) => updateTest(test.key, testSelection(options, product, parameterId, methodId));
  const textField = (key, label, props = {}) => <SampleTextField label={label} value={product[key]} disabled={disabled} onChange={(value) => onChange({ [key]: value })} {...props} />;
  return <div className={index > 0 ? 'border-top pt-4' : ''}>
    <div className="d-flex align-items-center justify-content-between gap-3 mb-4">
      <div className="d-inline-flex align-items-center gap-2 h5 fw-semibold text-body mb-0">
        <span className="smplfy-badge badge text-bg-primary rounded-circle d-inline-flex align-items-center justify-content-center">{index + 1}</span><span>Product {index + 1}</span>
      </div>
      <button type="button" className="smplfy-btn btn btn-outline-danger btn-sm" aria-label="Remove product" disabled={disabled || used} onClick={onRemove}><AppIcon name="trash" /></button>
    </div>
    <div className="row g-4">
      <div className="col-lg-6"><SampleSelectField label="Category" required={required} value={product.sampleCategoryId} options={categoryOptions} placeholder="Select sample category" disabled={disabled || used}
        onChange={(value) => onChange({ sampleCategoryId: value, productId: '', tagId: '', tests: [newTest()] })} /></div>
      <div className="col-lg-6"><SampleSelectField label="Tag" value={product.tagId} options={tagOptions}
        placeholder={!product.sampleCategoryId ? 'Select category first' : !categoryTags.size ? 'No tags for this category' : 'Filter by tag (optional)'} disabled={disabled || used || !product.sampleCategoryId}
        onChange={(value) => onChange({ tagId: value, productId: '', tests: [newTest()] })} /></div>
      <div className="col-lg-6"><SampleSelectField label="Product" required={required} value={product.productId} options={productOptions}
        placeholder={!product.sampleCategoryId ? 'Select category first' : !product.tagId ? 'Select tag first or select directly' : !products.length ? 'No products match selected tag' : 'Select product'}
        disabled={disabled || used || !product.sampleCategoryId} onChange={(value) => onChange({ productId: value, tests: [newTest()] })} /></div>
      <div className="col-12">{textField('description', 'Description', { textarea: true, rows: 2, placeholder: 'Sample Description', maxLength: 2000 })}</div>
      <div className="col-lg-6">{textField('quantity', 'Quantity', { type: 'number', step: 'any', min: '0', required, placeholder: '0' })}</div>
      <div className="col-lg-6"><div className="smplfy-form-field"><div className="smplfy-form-label-row"><label className="smplfy-form-label form-label" htmlFor={`${product.key}-size`}>Sample Size</label></div>
        <div className="sample-form-size-grid">{textField('sampleSize', null, { id: `${product.key}-size`, placeholder: 'Value', maxLength: 120 })}
          <SampleSelectField value={product.measurementUnitId} options={unitOptions} placeholder="Unit" aria-label="Sample size unit" disabled={disabled} onChange={(value) => onChange({ measurementUnitId: value })} />
        </div></div></div>
      <div className="col-lg-6">{textField('quality', 'Quality', { placeholder: 'Quality of sample', maxLength: 200 })}</div>
      <div className="col-lg-6">{textField('identificationMark', 'Identification Mark', { placeholder: 'if any', maxLength: 250 })}</div>
      <div className="col-lg-6">{textField('condition', 'Condition', { placeholder: 'eg. good, fair', maxLength: 250 })}</div>
      <div className="col-lg-6"><SampleImageField productKey={product.key} imageFileId={product.imageFileId} image={product.image}
        disabled={disabled} onChange={onChange} onBusy={onImageBusy} /></div>
    </div>
    <div className="d-flex align-items-center justify-content-between gap-3 mt-4 mb-3 flex-wrap">
      <h3 className="h5 fw-semibold text-body mb-0">Parameter Data</h3>
      <div className="d-flex align-items-center gap-3 flex-wrap"><div className="small text-muted">Amount: <strong>{currency === 'INR' ? '₹' : `${currency} `}{estimatedAmount([product], kind).toFixed(2)}</strong></div>
        <button type="button" className="smplfy-btn btn btn-link p-0 text-decoration-underline" disabled={disabled || used || !product.productId || !parameters.length}
          onClick={() => onChange({ tests: parameters.map((parameter) => ({ ...newTest(), ...testSelection(options, product, parameter.id) })) })}>Auto-fill parameters</button>
      </div>
    </div>
    <div className="table-responsive sample-form-validation-group">
      <table className="smplfy-table table table-borderless align-middle mb-0"><thead><tr>
        {kind === 'complaint' ? <th className="text-center" scope="col">Retest</th> : null}
        <th scope="col">Parameter <span className="text-danger">*</span></th><th scope="col">Test Method <span className="text-danger">*</span></th>
        <th scope="col">Req. Size</th><th scope="col">Charges</th><th scope="col">Est. Time</th><th className="text-end" scope="col">Action</th>
      </tr></thead><tbody>{product.tests.map((test, testIndex) => {
        const previous = savedTests.get(test.id); const inUse = previous && testInUse(previous);
        const parameterOptions = retainedSampleOption(optionList(parameters), test.testParameterId, sameContext ? previous?.testParameterId : null, previous?.parameterName);
        const methodOptions = retainedSampleOption(optionList(availableMethods(options, product, test.testParameterId)), test.methodId,
          sameContext && test.testParameterId === previous?.testParameterId ? previous?.methodId : null, previous?.methodName);
        return <tr key={test.key}>
        {kind === 'complaint' ? <td className="text-center align-middle"><Checkbox checked={test.isRetest} ariaLabel={`Retest parameter ${testIndex + 1}`} disabled={(disabled && !canEditRetest) || inUse} onChange={(value) => updateTest(test.key, { isRetest: value })} /></td> : null}
        <td className="sample-form-parameter-table__cell--parameter"><div className="sample-form-parameter-field">
          <SampleSelectField value={test.testParameterId} options={parameterOptions} placeholder="Select parameter…" aria-label={`Parameter ${testIndex + 1}`}
            required={kind !== 'complaint' || test.isRetest} disabled={disabled || inUse || !product.productId} onChange={(value) => selectTest(test, value)} />
          <span className={`badge sample-form-nabl-badge ${test.isAccredited ? 'text-bg-success' : 'text-bg-secondary'}`} title="Accreditation from the selected decision rule">{test.isAccredited ? 'NABL' : 'Non NABL'}</span>
        </div></td>
        <td className="sample-form-parameter-table__cell--wide"><SampleSelectField value={test.methodId} options={methodOptions} placeholder="Test method…"
          aria-label={`Test method ${testIndex + 1}`} required={kind !== 'complaint' || test.isRetest} disabled={disabled || inUse || !test.testParameterId} onChange={(value) => selectTest(test, test.testParameterId, value)} /></td>
        <td className="sample-form-parameter-table__cell--compact"><SampleTextField value={test.requestedSize} aria-label={`Requested size ${testIndex + 1}`} placeholder="—" maxLength={150} disabled={disabled} onChange={(value) => updateTest(test.key, { requestedSize: value })} /></td>
        <td className="sample-form-parameter-table__cell--compact"><SampleTextField type="number" min="0" step="any" value={test.rate} aria-label={`Charges ${testIndex + 1}`} placeholder={currency === 'INR' ? '₹' : currency} disabled={disabled} onChange={(value) => updateTest(test.key, { rate: value })} /></td>
        <td className="sample-form-parameter-table__cell--tiny"><SampleTextField type="number" min="0" step="any" value={test.estimatedDurationDays} aria-label={`Estimated days ${testIndex + 1}`} placeholder="days" disabled={disabled} onChange={(value) => updateTest(test.key, { estimatedDurationDays: value })} /></td>
        <td className="text-end align-middle"><button type="button" className="smplfy-btn btn btn-outline-danger btn-sm" aria-label="Remove parameter" disabled={disabled || inUse} onClick={() => onChange({ tests: product.tests.filter((item) => item.key !== test.key) })}><AppIcon name="trash" /></button></td>
      </tr>; })}</tbody></table>
      <button className="smplfy-btn btn btn-outline-secondary w-100 mt-2" type="button" disabled={disabled || product.tests.length >= 1000}
        onClick={() => onChange({ tests: [...product.tests, newTest()] })}><AppIcon name="plus" /><span>Add New Parameter</span></button>
    </div>
  </div>;
});
