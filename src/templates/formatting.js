const MAX_DECIMAL_POINTS = 100;

function toFiniteNumber(value) {
  if (value == null || value === "") return null;
  if (!["number", "string"].includes(typeof value)) return null;

  const normalizedValue = typeof value === "string" ? value.trim() : value;
  if (normalizedValue === "") return null;

  const numericValue = Number(normalizedValue);
  return Number.isFinite(numericValue) ? numericValue : null;
}

export function getDecimalPrecision(value) {
  const precision = toFiniteNumber(value);

  if (
    precision == null ||
    !Number.isInteger(precision) ||
    precision < 0 ||
    precision > MAX_DECIMAL_POINTS
  ) {
    return null;
  }

  return precision;
}

export function isDecimalPaddingEnabled(value) {
  if (value === true || value === 1) return true;
  return ["true", "1", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

export function formatValueWithDecimalPoints(
  value,
  decimalPoints,
  showDecimalPoints = false,
) {
  const precision = getDecimalPrecision(decimalPoints);
  if (precision == null) return value == null ? "" : value;

  const numericValue = toFiniteNumber(value);
  if (numericValue == null) return value == null ? "" : value;

  const fixedValue = numericValue.toFixed(precision);
  return isDecimalPaddingEnabled(showDecimalPoints)
    ? fixedValue
    : String(Number(fixedValue));
}
