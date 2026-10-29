const chunk = require('lodash/chunk');
const flatten = require('lodash/flatten');
const delay = require('./internal/delay');
const { isNumber } = require('../util/is');

// A null row would stop the insert there and silently drop every row after it.
function assertBatchRows(batch) {
  batch.forEach((row, rowIndex) => {
    if (row === null || typeof row !== 'object') {
      throw new TypeError(
        `Invalid batchInsert row ${rowIndex}: ${String(row)}`
      );
    }
  });
}

// Split `batch` into chunks of at most `chunkSize` rows that stay under the
// dialect's bind-parameter cap (mssql: 2098). The distinct keys across the
// whole batch, plus any parameter the dialect adds per row, bound one row's
// bind parameters: a row missing a key binds fewer, as its value compiles to a
// literal `DEFAULT`.
function chunkRowsByBindParameters(client, batch, chunkSize, returning) {
  const columnNames = [...new Set(batch.flatMap((row) => Object.keys(row)))];
  const rowBindParameters = client.client.batchInsertRowBindParameters(
    columnNames,
    returning,
    batch
  );
  const maxBindParameters = client.client.maxBindParameters || Infinity;
  const maxRowsByBindParameters =
    rowBindParameters > 0
      ? Math.max(1, Math.floor(maxBindParameters / rowBindParameters))
      : Infinity;
  return chunk(batch, Math.min(chunkSize, maxRowsByBindParameters));
}

function batchInsert(client, tableName, batch, chunkSize = 1000) {
  let returning = undefined;
  let transaction = null;
  if (!isNumber(chunkSize) || chunkSize < 1) {
    throw new TypeError(`Invalid chunkSize: ${chunkSize}`);
  }
  if (!Array.isArray(batch)) {
    throw new TypeError(`Invalid batch: Expected array, got ${typeof batch}`);
  }

  const runInTransaction = (cb) => {
    if (transaction) {
      return cb(transaction);
    }
    return client.transaction(cb);
  };

  return Object.assign(
    Promise.resolve().then(async () => {
      //Next tick to ensure wrapper functions are called if needed
      await delay(1);
      assertBatchRows(batch);
      // After the tick, as `returning` is set once batchInsert has returned.
      const chunks = chunkRowsByBindParameters(
        client,
        batch,
        chunkSize,
        returning
      );
      return runInTransaction(async (tr) => {
        const chunksResults = [];
        for (const items of chunks) {
          chunksResults.push(await tr(tableName).insert(items, returning));
        }
        return flatten(chunksResults);
      });
    }),
    {
      returning(columns) {
        returning = columns;

        return this;
      },
      transacting(tr) {
        transaction = tr;

        return this;
      },
    }
  );
}

module.exports = batchInsert;
