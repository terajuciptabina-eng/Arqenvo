/** RFC 4180-compatible CSV serialization for element schedules. */
export const SCHEDULE_COLUMNS = Object.freeze(["id","type","story","length","area","material"]);
export function csvField(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}
export function serializeScheduleCsv(rows, columns = SCHEDULE_COLUMNS) {
  if (!Array.isArray(rows) || !Array.isArray(columns) || columns.some(c => typeof c !== "string")) {
    throw new TypeError("Schedule rows and column names must be arrays");
  }
  const lines = [columns.map(csvField).join(",")];
  for (const row of rows) lines.push(columns.map(key => csvField(row?.[key])).join(","));
  return "\ufeff" + lines.join("\r\n") + "\r\n";
}
