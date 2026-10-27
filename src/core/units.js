export const METRES_PER_FOOT = 0.3048;
export const INCHES_PER_METRE = 39.37007874015748;

export function normalizeUnitSystem(value) {
  return value === "imperial" ? "imperial" : "metric";
}

export function formatLength(metres, unitSystem = "metric") {
  const value = Number(metres);
  if (!Number.isFinite(value)) return "—";
  if (normalizeUnitSystem(unitSystem) === "imperial") {
    const totalInches = Math.round(Math.abs(value) * INCHES_PER_METRE);
    const feet = Math.floor(totalInches / 12);
    const inches = totalInches % 12;
    const sign = value < 0 ? "−" : "";
    return sign + feet + "′ " + inches + "″";
  }
  const mm = Math.round(value * 1000);
  return mm.toLocaleString("en-US") + " mm";
}

export function formatLengthValue(metres, unitSystem = "metric") {
  const value = Number(metres);
  if (!Number.isFinite(value)) return "";
  if (normalizeUnitSystem(unitSystem) === "imperial") {
    const totalInches = Math.round(Math.abs(value) * INCHES_PER_METRE);
    const feet = Math.floor(totalInches / 12);
    const inches = totalInches % 12;
    return (value < 0 ? "−" : "") + feet + "' " + inches + '"';
  }
  return String(Number(value.toFixed(3)));
}

export function parseLength(value, unitSystem = "metric") {
  const text = String(value ?? "").trim();
  if (!text) return NaN;
  if (normalizeUnitSystem(unitSystem) === "imperial") {
    const imperial = text.match(/^\s*([+-]?\d+(?:\.\d+)?)\s*(?:ft|feet|′|')?\s*(?:(\d+(?:\.\d+)?)\s*(?:in|inches|″|")?)?\s*$/i);
    if (imperial && (/(?:ft|feet|′|')|(?:in|inches|″|")/i.test(text) || imperial[2] !== undefined)) {
      const feet = Number(imperial[1] || 0);
      const inches = Number(imperial[2] || 0);
      if (!Number.isFinite(feet) || !Number.isFinite(inches) || inches >= 12) return NaN;
      return Math.sign(feet || 1) * (Math.abs(feet) * METRES_PER_FOOT + inches * 0.0254);
    }
    const numericFeet = Number(text);
    return Number.isFinite(numericFeet) ? numericFeet * METRES_PER_FOOT : NaN;
  }
  const metric = text.match(/^\s*([+-]?\d+(?:\.\d+)?)\s*(mm|cm|m)?\s*$/i);
  if (!metric) return NaN;
  const n = Number(metric[1]);
  const factor = ({mm:0.001,cm:0.01,m:1})[(metric[2] || "m").toLowerCase()];
  return n * factor;
}

export function formatArea(squareMetres, unitSystem = "metric") {
  const value = Number(squareMetres);
  if (!Number.isFinite(value)) return "—";
  return (normalizeUnitSystem(unitSystem) === "imperial" ? value * 10.763910416709722 : value)
    .toFixed(2) + (normalizeUnitSystem(unitSystem) === "imperial" ? " ft²" : " m²");
}

export function toDisplayLength(metres, unitSystem = "metric") {
  return normalizeUnitSystem(unitSystem) === "imperial" ? metres / METRES_PER_FOOT : metres * 1000;
}

export function fromDisplayLength(value, unitSystem = "metric") {
  return normalizeUnitSystem(unitSystem) === "imperial" ? value * METRES_PER_FOOT : value / 1000;
}
