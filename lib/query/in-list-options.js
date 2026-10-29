const isPlainObject = require('lodash/isPlainObject');

const inListOptionNames = ['arrayParameterThreshold'];

// Throws unless `options`, the third argument of an `in` list method, is
// undefined or a plain object holding only known, valid options.
function assertInListOptions(methodName, options, maxBindParameters) {
  if (options === undefined) return;
  if (!isPlainObject(options)) {
    throw new TypeError(`Invalid ${methodName} options: ${String(options)}`);
  }
  for (const optionName of Object.keys(options)) {
    if (!inListOptionNames.includes(optionName)) {
      throw new TypeError(`Unknown ${methodName} option: ${optionName}`);
    }
  }
  assertArrayParameterThreshold(
    options.arrayParameterThreshold,
    maxBindParameters
  );
}

// The statement fields an `in` list method copies from its options.
function inListStatementFields(options) {
  if (options === undefined) return {};
  return { arrayParameterThreshold: options.arrayParameterThreshold };
}

// Throws unless `threshold` is null, undefined, -1 or an integer from 1 to
// `maxBindParameters`.
function assertArrayParameterThreshold(threshold, maxBindParameters) {
  if (threshold === null || threshold === undefined || threshold === -1) {
    return;
  }
  if (threshold === 0) {
    throw new TypeError(
      'arrayParameterThreshold 0: pass 1 to use one array parameter for any list of 2 or more, -1 to never'
    );
  }
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new TypeError(`Invalid arrayParameterThreshold: ${threshold}`);
  }
  if (threshold > maxBindParameters) {
    throw new TypeError(
      `arrayParameterThreshold ${threshold} exceeds the client's maxBindParameters ${maxBindParameters}`
    );
  }
}

module.exports = {
  assertInListOptions,
  inListStatementFields,
  assertArrayParameterThreshold,
};
