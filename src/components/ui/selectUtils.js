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
