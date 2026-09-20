export function normalizeSelectOption(option) {
  if (option && typeof option === 'object' && Array.isArray(option.options)) {
    return {
      label: option.label ?? '',
      options: normalizeSelectOptions(option.options),
    };
  }

  if (!option || typeof option !== 'object') {
    const scalar = option ?? '';
    return { value: scalar, label: scalar };
  }

  const hasLegacyKeyValuePair = option.key !== undefined
    && option.value !== undefined
    && option.label === undefined;

  return {
    ...option,
    value: hasLegacyKeyValuePair ? option.key : option.value ?? option.key ?? option._id ?? '',
    label: option.label
      ?? (hasLegacyKeyValuePair
        ? option.value
        : option.name ?? option.value ?? option.key ?? option._id ?? ''),
  };
}

export function normalizeSelectOptions(options = []) {
  return Array.isArray(options) ? options.map(normalizeSelectOption) : [];
}

export function flattenSelectOptions(options = []) {
  return options.flatMap((option) =>
    Array.isArray(option.options) ? flattenSelectOptions(option.options) : [option]);
}

export function selectValueKey(value, caseInsensitiveValues = false) {
  const key = String(value);
  return caseInsensitiveValues ? key.toLowerCase() : key;
}

export function prepareSelectOptions(options = [], { caseInsensitiveValues = false } = {}) {
  const normalizedOptions = normalizeSelectOptions(options);
  const flatOptions = flattenSelectOptions(normalizedOptions);
  return { sourceOptions: options, options: normalizedOptions, caseInsensitiveValues,
    byValue: new Map(flatOptions.map(option => [selectValueKey(option.value, caseInsensitiveValues), option])) };
}

export function selectOptionForValue(value, model, fallbackOptions = []) {
  const key = selectValueKey(value, model.caseInsensitiveValues);
  const option = model.byValue.get(key) ?? fallbackOptions.find(option => selectValueKey(option.value, model.caseInsensitiveValues) === key);
  if (!option) return { value, label: String(value) };
  // A canonical UUID option supplies its label while the selected raw value stays intact.
  return model.caseInsensitiveValues && option.value !== value ? { ...option, value } : option;
}

export function cacheSelectFilter(filter, emptyInputFilter = filter) {
  let inputValue; let results = new WeakMap();
  const primitive = value => value == null || ['string', 'number', 'boolean'].includes(typeof value);
  function cachedFilter(option, input) {
    if (input !== inputValue) { inputValue = input; results = new WeakMap(); }
    if (!option?.data || typeof option.data !== 'object' || !primitive(option.label) || !primitive(option.value)) return filter(option, input);
    const previous = results.get(option.data); const isNew = option.data.__isNew__;
    if (previous && previous.label === option.label && previous.value === option.value && previous.isNew === isNew) return previous.result;
    const result = (typeof input === 'string' && !input.trim() ? emptyInputFilter : filter)(option, input);
    results.set(option.data, { label: option.label, value: option.value, isNew, result }); return result;
  }
  cachedFilter.clear = () => { inputValue = undefined; results = new WeakMap(); };
  return cachedFilter;
}
