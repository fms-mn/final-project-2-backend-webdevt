// A tiny in-memory stand-in for MongoDB, used by the offline tests. It patches the real Mongoose
// models, so schema validation, defaults and pre-validate hooks (seat label generation, price
// and time checks) still run for real. Only the query features the routes use are implemented:
// equality, boolean filters, comparisons, regex, sort/paging and the scoped booking aggregation.
const test = require('node:test');
const mongoose = require('mongoose');

const idOf = (value) => String(value?._id ?? value);
const asNumber = (value) => (value instanceof Date ? value.getTime() : Number(value));
const same = (a, b) => (
  (a instanceof Date || b instanceof Date) ? asNumber(a) === asNumber(b) : idOf(a) === idOf(b)
);

function matchesCondition(value, condition) {
  const isOperators = condition && typeof condition === 'object' && !(condition instanceof Date)
    && !Array.isArray(condition) && Object.keys(condition).some((key) => key.startsWith('$'));
  if (!isOperators) return same(value, condition);
  return Object.entries(condition).every(([operator, operand]) => {
    if (operand instanceof Date && ['$gt', '$gte', '$lt', '$lte'].includes(operator) && !(value instanceof Date)) return false;
    switch (operator) {
      case '$in': return operand.some((item) => same(value, item));
      case '$ne': return !same(value, operand);
      case '$gt': return asNumber(value) > asNumber(operand);
      case '$gte': return asNumber(value) >= asNumber(operand);
      case '$lt': return asNumber(value) < asNumber(operand);
      case '$lte': return asNumber(value) <= asNumber(operand);
      case '$regex': return typeof value === 'string' && new RegExp(operand, condition.$options).test(value);
      case '$options': return true;
      default: throw new Error(`fakeDb does not support ${operator}`);
    }
  });
}

const field = (doc, path) => path.split('.').reduce((value, key) => value?.[key], doc);
const matches = (doc, filter = {}) => Object.entries(filter).every(([key, condition]) => (
  key === '$or' ? condition.some(item => matches(doc, item))
    : key === '$and' ? condition.every(item => matches(doc, item)) : matchesCondition(field(doc, key), condition)
));

const collections = new Map();
const compare = (a, b) => a instanceof Date || b instanceof Date ? asNumber(a) - asNumber(b)
  : typeof a === 'number' && typeof b === 'number' ? a - b : String(a ?? '').localeCompare(String(b ?? ''));
const sorted = (rows, spec) => rows.sort((a, b) => {
  for (const [key, direction] of Object.entries(spec)) { const difference = compare(field(a, key), field(b, key)); if (difference) return difference * direction; }
  return 0;
});
function expression(doc, value) {
  if (typeof value === 'string' && value.startsWith('$')) return field(doc, value.slice(1));
  if (value?.$ifNull) return expression(doc, value.$ifNull[0]) ?? expression(doc, value.$ifNull[1]);
  if (value?.$dateToString) {
    const options = value.$dateToString, date = expression(doc, options.date);
    return date ? new Date(date).toLocaleDateString('en-CA', { timeZone: options.timezone }) : options.onNull;
  }
  return value;
}
function aggregate(rows, pipeline) {
  for (const stage of pipeline) {
    const [name, options] = Object.entries(stage)[0];
    switch (name) {
      case '$match': rows = rows.filter(doc => matches(doc, options)); break;
      case '$lookup': rows = rows.map(doc => ({ ...doc, [options.as]: (collections.get(options.from) || []).filter(joined => same(field(doc, options.localField), field(joined, options.foreignField))).map(joined => joined.toObject()) })); break;
      case '$unwind': {
        const key = options.path.slice(1);
        rows = rows.flatMap(doc => doc[key]?.length ? doc[key].map(value => ({ ...doc, [key]: value })) : options.preserveNullAndEmptyArrays ? [{ ...doc, [key]: null }] : []);
        break;
      }
      case '$set': rows = rows.map(doc => ({ ...doc, ...Object.fromEntries(Object.entries(options).map(([key, value]) => [key, expression(doc, value)])) })); break;
      case '$sort': rows = sorted([...rows], options); break;
      case '$skip': rows = rows.slice(options); break;
      case '$limit': rows = rows.slice(0, options); break;
      case '$count': rows = rows.length ? [{ [options]: rows.length }] : []; break;
      case '$facet': rows = [Object.fromEntries(Object.entries(options).map(([key, steps]) => [key, aggregate([...rows], steps)]))]; break;
      case '$group': {
        const groups = new Map();
        for (const doc of rows) { const key = expression(doc, options._id); groups.set(key, (groups.get(key) || 0) + 1); }
        rows = [...groups].map(([_id, total]) => ({ _id, total }));
        break;
      }
      default: throw new Error(`fakeDb aggregate does not support ${name}`);
    }
  }
  return rows;
}

function query(getRows, { single = false, shape, many = false } = {}) {
  let sortSpec = null;
  let skipBy = 0;
  let limitTo = Infinity;
  const run = () => {
    let rows = getRows().slice();
    if (sortSpec) {
      sorted(rows, sortSpec);
    }
    rows = rows.slice(skipBy, skipBy + limitTo);
    if (single) return rows[0] ? (shape ? shape(rows[0]) : rows[0]) : null;
    return many && shape ? rows.map(shape) : rows;
  };
  const q = {
    sort(spec) { sortSpec = spec; return q; },
    skip(n) { skipBy = n; return q; },
    limit(n) { limitTo = n; return q; },
    select() { return q; },
    session() { return q; },
    then: (resolve, reject) => Promise.resolve().then(run).then(resolve, reject),
  };
  return q;
}

// Patches `Model` so it reads and writes `rows` (an array this function keeps in sync).
function fakeModel(Model, rows, { uniqueOn } = {}) {
  collections.set(Model.collection.name, rows);
  test.mock.method(Model, 'aggregate', async pipeline => aggregate(rows.map(doc => doc.toObject()), pipeline));
  // Reads hand out copies, as a real database does: changing a copy (even a rejected change)
  // never touches the stored data until save() succeeds.
  const view = (doc) => {
    const copy = Model.hydrate(doc.toObject());
    copy.$__row = doc;
    return copy;
  };
  const find = (filter) => query(() => rows.filter((doc) => matches(doc, filter)), { shape: view, many: true });
  const findOne = (filter) => query(() => rows.filter((doc) => matches(doc, filter)), { single: true, shape: view });
  test.mock.method(Model, 'find', find);
  test.mock.method(Model, 'findOne', findOne);
  test.mock.method(Model, 'findById', (id) => findOne({ _id: id }));
  test.mock.method(Model, 'exists', (filter) => query(
    () => rows.filter((doc) => matches(doc, filter)),
    { single: true, shape: (doc) => ({ _id: doc._id }) },
  ));
  test.mock.method(Model, 'countDocuments', async (filter) => rows.filter((doc) => matches(doc, filter)).length);
  const remove = async (filter) => {
    const keep = rows.filter((doc) => !matches(doc, filter));
    const deleted = rows.length - keep.length;
    rows.splice(0, rows.length, ...keep);
    return { deletedCount: deleted };
  };
  test.mock.method(Model, 'deleteOne', async (filter) => {
    const index = rows.findIndex((doc) => matches(doc, filter));
    if (index >= 0) rows.splice(index, 1);
    return { deletedCount: index >= 0 ? 1 : 0 };
  });
  test.mock.method(Model, 'deleteMany', remove);
  const apply = (doc, update) => {
    for (const [field, amount] of Object.entries(update.$inc || {})) doc[field] = (doc[field] || 0) + amount;
    for (const [field, value] of Object.entries(update.$set || {})) doc[field] = value;
  };
  test.mock.method(Model, 'updateOne', async (filter, update) => {
    const doc = rows.find((item) => matches(item, filter));
    if (doc) apply(doc, update);
    return { modifiedCount: doc ? 1 : 0 };
  });
  test.mock.method(Model, 'updateMany', async (filter, update) => {
    const found = rows.filter((doc) => matches(doc, filter));
    found.forEach((doc) => apply(doc, update));
    return { modifiedCount: found.length };
  });
  // `uniqueOn` is a field name or a list of field names that must be unique together.
  const uniqueFields = uniqueOn ? [].concat(uniqueOn) : null;
  const clashes = (doc) => uniqueFields && rows.some(
    (other) => other !== doc && uniqueFields.every((field) => same(other[field], doc[field])),
  );
  const duplicateKey = () => Object.assign(new Error('duplicate key'), { code: 11000 });
  test.mock.method(Model.prototype, 'save', async function save() {
    await this.validate();
    if (this.$__row) { // an update: copy the saved copy back onto the stored document
      const saved = this.toObject();
      // A field that was cleared on the copy is unset in the real database too.
      for (const field of Object.keys(this.$__row.toObject())) {
        if (!(field in saved)) this.$__row.set(field, undefined);
      }
      this.$__row.set(saved);
      return this;
    }
    if (!rows.includes(this)) {
      if (clashes(this)) throw duplicateKey();
      rows.push(this);
    }
    this.$isNew = false;
    return this;
  });
  // Like the real ordered insertMany: documents before a duplicate stay inserted (inside a
  // transaction the rollback removes them again).
  test.mock.method(Model, 'insertMany', async (docs) => {
    const inserted = [];
    for (const fields of docs) {
      const doc = new Model(fields);
      await doc.validate();
      if (clashes(doc)) throw duplicateKey();
      doc.$isNew = false;
      rows.push(doc);
      inserted.push(doc);
    }
    return inserted;
  });
}

// Replaces mongoose.startSession. `beforeAttempt(attempt)` can change the data and return true
// to make that attempt fail with a transient transaction error, like a real write conflict:
// the callback is then run again from scratch, exactly as the MongoDB driver does.
// `stores` are the row arrays to roll back when the callback throws, like a real abort.
// `transient(attempt)` can make an attempt fail with a retryable error after it ran.
function fakeTransactions({ beforeAttempt, stores = [], transient, maxAttempts = 50 } = {}) {
  const snapshot = () => stores.map((rows) => rows.map((doc) => [doc, doc.toObject()]));
  const restore = (saved) => saved.forEach((entries, index) => {
    stores[index].splice(0, stores[index].length, ...entries.map(([doc]) => doc));
    entries.forEach(([doc, data]) => doc.set(data));
  });
  test.mock.method(mongoose, 'startSession', async () => ({
    async withTransaction(work) {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (beforeAttempt && beforeAttempt(attempt)) continue;
        const saved = snapshot();
        try {
          await work();
          if (transient && transient(attempt)) { restore(saved); continue; }
          return;
        } catch (error) {
          restore(saved);
          throw error;
        }
      }
      throw new Error('too many transaction retries');
    },
    async endSession() {},
  }));
}

module.exports = { fakeModel, fakeTransactions, matches };
