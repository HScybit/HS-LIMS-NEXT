'use client';

import React, { useCallback, useId, useMemo, useState } from 'react';
import cx from 'classnames';
import BaseSelect, { components, createFilter } from 'react-select';
import AsyncSelect from 'react-select/async';
import CreatableSelect from 'react-select/creatable';
import AppIcon from './AppIcon.jsx';
import WindowedSelectMenuList from './WindowedSelectMenuList.jsx';
import { cacheSelectFilter, flattenSelectOptions, prepareSelectOptions } from './selectUtils.js';
import '../../styles/searchable-select.scss';

function buildValueSet(selectedOptions) {
  const values = Array.isArray(selectedOptions)
    ? selectedOptions
    : selectedOptions
      ? [selectedOptions]
      : [];

  return new Set(values.map((option) => String(option.value)));
}

function isOptionDisabled(option, selectProps) {
  if (typeof selectProps.isOptionDisabled === 'function') {
    return Boolean(selectProps.isOptionDisabled(option, selectProps.value));
  }

  return Boolean(option?.isDisabled || option?.disabled);
}

function normalizeValue(value, multiple) {
  if (multiple) {
    return Array.isArray(value) ? value.filter((item) => item !== undefined && item !== null && item !== '') : [];
  }

  return value ?? '';
}

function DropdownIndicator(props) {
  return (
    <components.DropdownIndicator {...props}>
      <span
        className={cx(
          'smplfy-rselect__indicator-icon',
          props.selectProps.menuIsOpen && 'is-open',
        )}
        aria-hidden="true"
      >
        <AppIcon name="chevron-down" size={14} />
      </span>
    </components.DropdownIndicator>
  );
}

function ClearIndicator(props) {
  return (
    <components.ClearIndicator {...props}>
      <span className="smplfy-rselect__indicator-icon" aria-hidden="true">
        <AppIcon name="close" size={14} />
      </span>
    </components.ClearIndicator>
  );
}

function MultiValueRemove(props) {
  return (
    <components.MultiValueRemove {...props}>
      <AppIcon name="close" size={11} />
    </components.MultiValueRemove>
  );
}

function MultiValue(props) {
  const maxVisibleValues = props.selectProps.maxVisibleValues ?? 2;
  const selectedValues = props.getValue();

  if (props.index < maxVisibleValues) {
    return <components.MultiValue {...props} />;
  }

  if (props.index === maxVisibleValues) {
    return (
      <div className="smplfy-rselect__multi-summary">
        +{selectedValues.length - maxVisibleValues} more
      </div>
    );
  }

  return null;
}

function Option(props) {
  const { isMulti, isSelected, label } = props;

  return (
    <components.Option {...props}>
      {isMulti ? (
        <span className="smplfy-rselect__option-checkbox" aria-hidden="true">
          {isSelected ? <AppIcon name="check" size={11} /> : null}
        </span>
      ) : null}
      <span className="smplfy-rselect__option-label">{label}</span>
      {!isMulti && isSelected ? (
        <span className="smplfy-rselect__option-selected" aria-hidden="true">
          <AppIcon name="check" size={13} />
        </span>
      ) : null}
    </components.Option>
  );
}

function MenuList(props) {
  const { children, options, selectProps } = props;
  const visibleSelectableOptions = useMemo(
    () => flattenSelectOptions(options).filter((option) => !isOptionDisabled(option, selectProps)),
    [options, selectProps],
  );
  const selectedSet = useMemo(() => buildValueSet(selectProps.value), [selectProps.value]);
  const selectedVisibleCount = visibleSelectableOptions.reduce(
    (count, option) => count + (selectedSet.has(String(option.value)) ? 1 : 0),
    0,
  );
  const allVisibleSelected = visibleSelectableOptions.length > 0
    && selectedVisibleCount === visibleSelectableOptions.length;
  const partiallyVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const hasFilter = Boolean(selectProps.inputValue?.trim()) || selectProps.bulkActionScope === 'visible';
  const selectedCount = Array.isArray(selectProps.value) ? selectProps.value.length : 0;
  const toggleLabel = allVisibleSelected
    ? (hasFilter ? 'Deselect visible' : 'Deselect all')
    : (hasFilter ? 'Select visible' : 'Select all');

  const actions = selectProps.isMulti && selectProps.enableBulkActions !== false ? (
        <div className="smplfy-rselect__actions" onMouseDown={(event) => event.preventDefault()}>
          <button
            type="button"
            className={cx(
              'smplfy-rselect__action-button',
              allVisibleSelected && 'is-active',
              partiallyVisibleSelected && 'is-partial',
            )}
            onClick={() => selectProps.onToggleVisibleOptions?.(visibleSelectableOptions, allVisibleSelected)}
            disabled={visibleSelectableOptions.length === 0}
          >
            {toggleLabel}
          </button>
          <button
            type="button"
            className="smplfy-rselect__action-button smplfy-rselect__action-button--muted"
            onClick={() => selectProps.onClearAllSelections?.()}
            disabled={selectedCount === 0}
          >
            {selectedCount > 0 ? `Clear all (${selectedCount})` : 'Clear all'}
          </button>
          {visibleSelectableOptions.length > 0 ? (
            <div className="smplfy-rselect__action-meta">
              {selectedVisibleCount}/{visibleSelectableOptions.length} visible selected
            </div>
          ) : null}
        </div>
      ) : null;
  if (selectProps.windowedOptions && Array.isArray(children) && children.length > 1000
    && children.every(child => React.isValidElement(child) && child.props.innerProps?.role === 'option')) {
    return <WindowedSelectMenuList {...props} actions={actions} />;
  }
  return <components.MenuList {...props}>{actions}{children}</components.MenuList>;
}

const sharedComponents = {
  ClearIndicator,
  DropdownIndicator,
  IndicatorSeparator: null,
  MenuList,
  MultiValue,
  MultiValueRemove,
  Option,
};

export default function SearchableSelect({
  value,
  defaultValue,
  onChange,
  options = [],
  preparedOptions,
  windowedOptions = false,
  multiple = false,
  placeholder = 'Select…',
  disabled = false,
  clearable,
  isClearable,
  isLoading = false,
  loadOptions,
  filterOption,
  defaultOptions = true,
  cacheOptions = true,
  searchable = true,
  className = '',
  id,
  inputId,
  name,
  onBlur,
  onFocus,
  onInputChange,
  menuPortalTarget,
  noOptionsMessage = 'No options found',
  loadingMessage = 'Loading…',
  closeMenuOnSelect,
  menuShouldScrollIntoView = false,
  hideSelectedOptions = false,
  enableBulkActions = true,
  maxVisibleValues = 2,
  allowCustom = false,
  invalid = false,
  'aria-invalid': ariaInvalid,
  ...props
}) {
  const reactId = useId();
  const isControlled = value !== undefined;
  const [internalValue, setInternalValue] = useState(() =>
    normalizeValue(isControlled ? value : defaultValue, multiple),
  );
  const [inputValue, setInputValue] = useState('');
  const cachedDefaultFilter = useMemo(() => cacheSelectFilter(createFilter(), createFilter({ ignoreAccents: false })), []);
  const optionModel = useMemo(() => preparedOptions?.sourceOptions === options ? preparedOptions : prepareSelectOptions(options), [options, preparedOptions]);
  const normalizedOptions = optionModel.options;
  const optionMap = optionModel.byValue;
  const currentValue = isControlled ? normalizeValue(value, multiple) : internalValue;
  const hasSelection = multiple
    ? Array.isArray(currentValue) && currentValue.length > 0
    : Boolean(currentValue);

  const selectedOption = useMemo(() => {
    if (multiple) {
      const values = Array.isArray(currentValue) ? currentValue : [];
      return values.map((item) => optionMap.get(String(item)) ?? { value: item, label: String(item) });
    }

    if (!currentValue) {
      return null;
    }

    return optionMap.get(String(currentValue)) ?? { value: currentValue, label: String(currentValue) };
  }, [currentValue, multiple, optionMap]);

  const handleChange = useCallback((nextSelection) => {
    const nextValue = multiple
      ? (Array.isArray(nextSelection) ? nextSelection.map((option) => option.value) : [])
      : (nextSelection?.value ?? '');

    if (!isControlled) {
      setInternalValue(nextValue);
    }

    onChange?.(nextValue, nextSelection);
  }, [isControlled, multiple, onChange]);

  const handleInputValueChange = useCallback((nextInputValue, actionMeta) => {
    const externalValue = onInputChange?.(nextInputValue, actionMeta);
    const resolvedValue = typeof externalValue === 'string' ? externalValue : nextInputValue;

    if (actionMeta.action === 'input-change') {
      setInputValue(resolvedValue);
    }

    if (actionMeta.action === 'menu-close' || actionMeta.action === 'set-value' || actionMeta.action === 'input-blur') {
      setInputValue('');
      cachedDefaultFilter.clear();
    }

    return externalValue ?? nextInputValue;
  }, [onInputChange, cachedDefaultFilter]);

  const buildSelectionFromValues = useCallback((nextValues, fallbackOptions = []) =>
    nextValues.map((item) =>
      optionMap.get(String(item))
      ?? fallbackOptions.find((option) => String(option.value) === String(item))
      ?? { value: item, label: String(item) }), [optionMap]);

  const handleToggleVisibleOptions = useCallback((visibleOptions, shouldDeselect) => {
    const currentValues = Array.isArray(currentValue) ? currentValue : [];
    const visibleValueSet = new Set(visibleOptions.map((option) => String(option.value)));

    const nextValues = shouldDeselect
      ? currentValues.filter((item) => !visibleValueSet.has(String(item)))
      : (() => {
          const existingValues = new Set(currentValues.map((item) => String(item)));
          const mergedValues = [...currentValues];

          visibleOptions.forEach((option) => {
            const optionValue = String(option.value);
            if (!existingValues.has(optionValue)) {
              existingValues.add(optionValue);
              mergedValues.push(option.value);
            }
          });

          return mergedValues;
        })();

    const nextSelection = buildSelectionFromValues(nextValues, visibleOptions);

    if (!isControlled) {
      setInternalValue(nextValues);
    }

    onChange?.(nextValues, nextSelection);
  }, [buildSelectionFromValues, currentValue, isControlled, onChange]);

  const handleClearAllSelections = useCallback(() => {
    if (!isControlled) {
      setInternalValue([]);
    }

    onChange?.([], []);
  }, [isControlled, onChange]);

  const SelectComponent = loadOptions ? AsyncSelect : allowCustom ? CreatableSelect : BaseSelect;
  const resolvedPortalTarget = menuPortalTarget === false
    ? undefined
    : menuPortalTarget ?? (typeof document !== 'undefined' ? document.body : undefined);
  const resolvedAriaInvalid = ariaInvalid ?? (invalid ? 'true' : undefined);

  return (
    <SelectComponent
      instanceId={id || inputId || reactId}
      inputId={inputId || id}
      name={name}
      unstyled
      className={cx('smplfy-rselect', invalid && 'is-invalid', className)}
      aria-invalid={resolvedAriaInvalid}
      classNames={{
        clearIndicator: () => 'smplfy-rselect__clear-indicator',
        control: ({ isDisabled, isFocused, menuIsOpen }) =>
          cx(
            'smplfy-rselect__control',
            hasSelection && 'is-filled',
            multiple && 'is-multi',
            isFocused && 'is-focused',
            menuIsOpen && 'is-open',
            isDisabled && 'is-disabled',
            invalid && 'is-invalid',
          ),
        dropdownIndicator: () => 'smplfy-rselect__dropdown-indicator',
        group: () => 'smplfy-rselect__group',
        groupHeading: () => 'smplfy-rselect__group-heading',
        input: () => 'smplfy-rselect__input',
        indicatorsContainer: () => 'smplfy-rselect__indicators',
        loadingMessage: () => 'smplfy-rselect__message',
        menu: () => 'smplfy-rselect__menu',
        menuList: () => 'smplfy-rselect__menu-list',
        multiValue: () => 'smplfy-rselect__multi-value',
        multiValueLabel: () => 'smplfy-rselect__multi-value-label',
        multiValueRemove: () => 'smplfy-rselect__multi-value-remove',
        noOptionsMessage: () => 'smplfy-rselect__message',
        option: ({ isFocused, isSelected }) =>
          cx(
            'smplfy-rselect__option',
            isFocused && 'is-focused',
            isSelected && 'is-selected',
          ),
        placeholder: () => 'smplfy-rselect__placeholder',
        singleValue: () => 'smplfy-rselect__single-value',
        valueContainer: () => 'smplfy-rselect__value-container',
      }}
      components={sharedComponents}
      options={loadOptions ? undefined : normalizedOptions}
      windowedOptions={windowedOptions && !loadOptions}
      filterOption={filterOption === undefined ? loadOptions ? undefined : cachedDefaultFilter : filterOption}
      loadOptions={loadOptions}
      defaultOptions={loadOptions ? defaultOptions : undefined}
      cacheOptions={loadOptions ? cacheOptions : undefined}
      value={selectedOption}
      onChange={handleChange}
      inputValue={inputValue}
      onInputChange={handleInputValueChange}
      onBlur={onBlur}
      onFocus={onFocus}
      placeholder={placeholder}
      isMulti={multiple}
      isDisabled={disabled}
      isLoading={isLoading}
      isSearchable={searchable}
      isClearable={isClearable ?? clearable ?? !multiple}
      closeMenuOnSelect={closeMenuOnSelect ?? !multiple}
      menuShouldScrollIntoView={menuShouldScrollIntoView}
      hideSelectedOptions={hideSelectedOptions}
      blurInputOnSelect={!multiple}
      menuPlacement="auto"
      menuPortalTarget={resolvedPortalTarget}
      menuPosition={resolvedPortalTarget ? 'fixed' : 'absolute'}
      noOptionsMessage={() => noOptionsMessage}
      loadingMessage={() => loadingMessage}
      enableBulkActions={multiple && enableBulkActions}
      maxVisibleValues={maxVisibleValues}
      onToggleVisibleOptions={handleToggleVisibleOptions}
      onClearAllSelections={handleClearAllSelections}
      styles={{
        menuPortal: (base) => ({
          ...base,
          zIndex: 100000020,
        }),
      }}
      {...props}
    />
  );
}
