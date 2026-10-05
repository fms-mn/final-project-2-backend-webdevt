// Small validators shared by the Mongoose schemas.

// Money is stored as integer centavos, so 400.00 pesos is 40000.
const integer = {
  validator: Number.isInteger,
  message: '{PATH} must be an integer',
};

// Mongoose's `required` accepts an empty array, so array fields need an explicit check.
const nonEmptyArray = {
  validator: (value) => Array.isArray(value) && value.length > 0,
  message: '{PATH} must contain at least one item',
};

const uniqueItems = {
  validator: (value) => new Set(value).size === value.length,
  message: '{PATH} must not contain duplicates',
};

const nonEmptyStrings = {
  validator: (value) => value.every((item) => typeof item === 'string' && item.trim().length > 0),
  message: '{PATH} must only contain non-empty text',
};

module.exports = { integer, nonEmptyArray, uniqueItems, nonEmptyStrings };
