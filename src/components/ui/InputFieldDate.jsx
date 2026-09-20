'use client';

import React, { useMemo, useRef, useState } from 'react';
import cx from 'classnames';
import AppIcon from './AppIcon.jsx';
import { toDisplayDate, parseVisibleDate, parseCalendarDate, formatDateInput } from './date-input.js';
import '../../styles/form-controls.scss';

function createChangeEvent(sourceEvent, value) {
  return {
    ...sourceEvent,
    target: {
      ...sourceEvent.target,
      value,
    },
  };
}

export default function InputFieldDate({
  state = 'default',
  value,
  defaultValue,
  placeholder = 'DD/MM/YYYY',
  className = '',
  disabled = false,
  calendarOnly = false,
  onChange,
  onBlur,
  onClick,
  onPointerDown,
  ...props
}) {
  const pickerRef = useRef(null);
  const visibleInputRef = useRef(null);
  const pointerOpenedPickerRef = useRef(false);
  const isControlled = value !== undefined;
  const sourceValue = isControlled ? value ?? '' : defaultValue ?? '';
  const initialParsed = useMemo(() => (calendarOnly ? parseCalendarDate(sourceValue) : parseVisibleDate(sourceValue)) ?? { display: sourceValue, iso: '' }, [sourceValue, calendarOnly]);
  const [textValue, setTextValue] = useState(initialParsed.display);
  const [pickerValue, setPickerValue] = useState(initialParsed.iso);
  const [lastValidText, setLastValidText] = useState(initialParsed.display);
  const [lastValidPickerValue, setLastValidPickerValue] = useState(initialParsed.iso);
  const [previousSource, setPreviousSource] = useState({ value: sourceValue, controlled: isControlled });

  // Reset the source editing buffer only when its controlled input changes; avoid an extra effect render.
  if (previousSource.value !== sourceValue || previousSource.controlled !== isControlled) {
    setPreviousSource({ value: sourceValue, controlled: isControlled });
    if (isControlled) {
      setTextValue(initialParsed.display); setPickerValue(initialParsed.iso);
      setLastValidText(initialParsed.display); setLastValidPickerValue(initialParsed.iso);
    }
  }

  const isDisabled = disabled || state === 'disabled';
  const isFilled = state === 'filled' || Boolean(textValue);
  const isInvalid = state === 'error';
  const visualState = isDisabled
    ? 'disabled'
    : state === 'hover'
      ? 'hover'
      : state === 'focused'
        ? 'focused'
        : state === 'error'
          ? 'error'
          : 'default';

  const openDatePicker = () => {
    if (isDisabled) return false;

    const picker = pickerRef.current;
    if (!picker) return false;

    picker.focus({ preventScroll: true });

    if (typeof picker.showPicker === 'function') {
      try {
        picker.showPicker();
        return true;
      } catch {
        // Fall back to click for browsers that reject showPicker on this input.
      }
    }

    picker.click();
    return true;
  };

  const skipNextClickPicker = () => {
    pointerOpenedPickerRef.current = true;
    window.setTimeout(() => {
      pointerOpenedPickerRef.current = false;
    }, 300);
  };

  return (
    <div
      className={cx(
        'smplfy-date-field',
        'input-group',
        isInvalid && 'is-invalid',
        !isFilled && 'smplfy-form-empty',
        visualState === 'hover' && 'smplfy-form-hover',
        visualState === 'focused' && 'smplfy-form-focused',
        className,
      )}
    >
      <input
        ref={visibleInputRef}
        className={cx(
          'smplfy-form-control',
          'form-control',
          !isFilled && 'smplfy-form-empty',
          isInvalid && 'is-invalid',
        )}
        type="text"
        inputMode="numeric"
        value={textValue}
        placeholder={placeholder}
        disabled={isDisabled}
        maxLength={10}
        pattern="\d{2}/\d{2}/\d{4}"
        onChange={(event) => {
          const nextValue = formatDateInput(event.target.value);
          setTextValue(nextValue);
          onChange?.(createChangeEvent(event, nextValue));
        }}
        onPointerDown={(event) => {
          onPointerDown?.(event);

          if (!event.defaultPrevented) {
            event.preventDefault();
            if (openDatePicker()) {
              skipNextClickPicker();
            }
          }
        }}
        onClick={(event) => {
          onClick?.(event);

          if (pointerOpenedPickerRef.current) {
            pointerOpenedPickerRef.current = false;
            return;
          }

          if (!event.defaultPrevented) {
            openDatePicker();
          }
        }}
        onBlur={(event) => {
          const parsed = calendarOnly ? parseCalendarDate(event.target.value) : parseVisibleDate(event.target.value);

          if (parsed) {
            setTextValue(parsed.display);
            setPickerValue(parsed.iso);
            setLastValidText(parsed.display);
            setLastValidPickerValue(parsed.iso);
            onChange?.(createChangeEvent(event, parsed.display));
          } else if (event.target.value.trim() && !calendarOnly) {
            setTextValue(lastValidText);
            setPickerValue(lastValidPickerValue);
            onChange?.(createChangeEvent(event, lastValidText));
          } else if (!event.target.value.trim()) {
            setTextValue('');
            setPickerValue('');
            setLastValidText('');
            setLastValidPickerValue('');
            onChange?.(createChangeEvent(event, ''));
          }

          onBlur?.(event);
        }}
        {...props}
      />

      <button
        type="button"
        className="smplfy-date-button smplfy-btn btn btn-light"
        aria-label="Open calendar"
        disabled={isDisabled}
        onClick={openDatePicker}
      >
        <AppIcon name="calendar" />
      </button>

      <input
        ref={pickerRef}
        className="visually-hidden"
        type="date"
        min={calendarOnly ? '0001-01-01' : undefined}
        max={calendarOnly ? '9999-12-31' : undefined}
        tabIndex={-1}
        aria-hidden="true"
        value={pickerValue}
        disabled={isDisabled}
        onChange={(event) => {
          setPickerValue(event.target.value);

          if (event.target.value) {
            const [year, month, day] = event.target.value.split('-').map(Number);
            const nextDate = new Date(year, month - 1, day);
            const nextDisplay = calendarOnly ? parseCalendarDate(event.target.value)?.display ?? event.target.value : toDisplayDate(nextDate);
            setTextValue(nextDisplay);
            setLastValidText(nextDisplay);
            setLastValidPickerValue(event.target.value);
            onChange?.(createChangeEvent(event, nextDisplay));
          } else {
            onChange?.(createChangeEvent(event, ''));
          }

          visibleInputRef.current?.focus();
        }}
      />
    </div>
  );
}
