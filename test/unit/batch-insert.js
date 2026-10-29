'use strict';

const { expect } = require('chai');
const knexLib = require('../../knex');
const batchInsert = require('../../lib/execution/batch-insert');

// batchInsert through a transaction stub that records each chunk's row count
// instead of running the insert, so the chunks are checked without a database.
describe('batchInsert (db-less)', function () {
  it('caps a pg chunk at 936 rows of 70 columns', async function () {
    const chunkLengths = [];
    await batchInsert(
      {
        client: knexLib({ client: 'pg' }).client,
        transaction: (callback) =>
          callback(() => ({
            insert: (rows) => chunkLengths.push(rows.length),
          })),
      },
      'users',
      Array.from({ length: 1000 }, () =>
        Object.fromEntries(
          Array.from({ length: 70 }, (_, index) => [`c${index}`, index])
        )
      ),
      1000
    );
    expect(chunkLengths).to.eql([936, 64]);
  });

  it('caps an mssql chunk at 699 rows of 3 columns', async function () {
    const chunkLengths = [];
    await batchInsert(
      {
        client: knexLib({ client: 'mssql' }).client,
        transaction: (callback) =>
          callback(() => ({
            insert: (rows) => chunkLengths.push(rows.length),
          })),
      },
      'users',
      Array.from({ length: 1000 }, () => ({ a: 1, b: 2, c: 3 })),
      1000
    );
    expect(chunkLengths).to.eql([699, 301]);
  });

  it('counts the distinct keys across the whole batch, not per row', async function () {
    const chunkLengths = [];
    await batchInsert(
      {
        client: knexLib({ client: 'mssql' }).client,
        transaction: (callback) =>
          callback(() => ({
            insert: (rows) => chunkLengths.push(rows.length),
          })),
      },
      'users',
      Array.from({ length: 2000 }, (_, index) =>
        index % 2 === 0 ? { a: 1 } : { b: 2 }
      ),
      2000
    );
    expect(chunkLengths).to.eql([1049, 951]);
  });
});
