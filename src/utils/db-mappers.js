/**
 * === PHASE 3: FIX #16 - NAMING CONVENTIONS ===
 * Utilities for consistent naming conversion between database and JavaScript.
 */

function snakeToCamel(snakeCase) {
  const str = String(snakeCase || '');
  return str.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
}

function camelToSnake(camelCase) {
  const str = String(camelCase || '');
  return str.replace(/([A-Z])/g, (match) => `_${match.toLowerCase()}`);
}

function dbRowToCamelCase(dbRow) {
  if (!dbRow || typeof dbRow !== 'object') return dbRow;
  const result = {};
  for (const [key, value] of Object.entries(dbRow)) {
    const camelKey = snakeToCamel(key);
    result[camelKey] = value;
  }
  return result;
}

function dbRowsToCamelCase(dbRows) {
  if (!Array.isArray(dbRows)) return dbRows;
  return dbRows.map(row => dbRowToCamelCase(row));
}

function camelCaseToDbRow(jsObj) {
  if (!jsObj || typeof jsObj !== 'object') return jsObj;
  const result = {};
  for (const [key, value] of Object.entries(jsObj)) {
    const snakeKey = camelToSnake(key);
    result[snakeKey] = value;
  }
  return result;
}

module.exports = {
  snakeToCamel,
  camelToSnake,
  dbRowToCamelCase,
  dbRowsToCamelCase,
  camelCaseToDbRow
};
