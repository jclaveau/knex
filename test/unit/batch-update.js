'use strict';

const { expect } = require('chai');
const knexLib = require('../../knex');
const {
  buildBatchUpdateQuery,
  updatableColumns,
} = require('../../lib/execution/batch-update');

// Per-dialect SQL generation for batchUpdate, asserted via toSQL() without a
// live database. Behavioural (real DML) coverage lives in the integration suite.
describe('batchUpdate (db-less)', function () {
  const clients = {};
  const dialects = [
    'pg',
    'mysql',
    'sqlite3',
    'mssql',
    'oracledb',
    'redshift',
    'cockroachdb',
  ];

  before(function () {
    for (const client of dialects) {
      clients[client] = knexLib({ client, useNullAsDefault: true });
    }
  });

  after(function () {
    return Promise.all(Object.values(clients).map((knex) => knex.destroy()));
  });

  const rows = [
    { id: 1, name: 'a', age: 10 },
    { id: 2, name: 'b', age: 20 },
  ];

  function sqlFor(client, key, columns, batch) {
    const knex = clients[client];
    return buildBatchUpdateQuery(
      knex,
      'users',
      Array.isArray(key) ? key : [key],
      columns,
      batch
    ).toSQL();
  }

  it('postgres emits UPDATE ... FROM (SELECT ...) with first-row casts', function () {
    const { sql, bindings } = sqlFor('pg', 'id', ['name', 'age'], rows);
    expect(sql).to.equal(
      'update "users" set "name" = "v"."name", "age" = "v"."age" from ' +
        '(select ?::numeric as "id", ?::text as "name", ?::numeric as "age" ' +
        'union all select ?, ?, ?) as "v" where "users"."id" = "v"."id"'
    );
    expect(bindings).to.eql([1, 'a', 10, 2, 'b', 20]);
  });

  it('cockroachdb and redshift reuse the postgres FROM form (no builder updateFrom)', function () {
    const expected =
      'update "users" set "name" = "v"."name", "age" = "v"."age" from ' +
      '(select ?::numeric as "id", ?::text as "name", ?::numeric as "age" ' +
      'union all select ?, ?, ?) as "v" where "users"."id" = "v"."id"';
    expect(sqlFor('cockroachdb', 'id', ['name', 'age'], rows).sql).to.equal(
      expected
    );
    expect(sqlFor('redshift', 'id', ['name', 'age'], rows).sql).to.equal(
      expected
    );
  });

  it('mysql emits UPDATE ... JOIN (derived) SET', function () {
    const { sql, bindings } = sqlFor('mysql', 'id', ['name', 'age'], rows);
    expect(sql).to.equal(
      'update `users` inner join (select ? as `id`, ? as `name`, ? as `age` ' +
        'union all select ?, ?, ?) as `src` on `users`.`id` = `src`.`id` ' +
        'set `users`.`name` = `src`.`name`, `users`.`age` = `src`.`age`'
    );
    expect(bindings).to.eql([1, 'a', 10, 2, 'b', 20]);
  });

  it('mssql emits UPDATE ... FROM ... JOIN with the @@rowcount tail', function () {
    const { sql } = sqlFor('mssql', 'id', ['name', 'age'], rows);
    expect(sql).to.equal(
      'update [users] set [users].[name] = [src].[name], ' +
        '[users].[age] = [src].[age] from [users] inner join ' +
        '(select ? as [id], ? as [name], ? as [age] union all select ?, ?, ?) ' +
        'as [src] on [users].[id] = [src].[id];select @@rowcount'
    );
  });

  it('sqlite emits UPDATE ... FROM (derived) without casts', function () {
    const { sql } = sqlFor('sqlite3', 'id', ['name', 'age'], rows);
    expect(sql).to.equal(
      'update `users` set `name` = `v`.`name`, `age` = `v`.`age` from ' +
        '(select ? as `id`, ? as `name`, ? as `age` union all select ?, ?, ?) ' +
        'as `v` where `users`.`id` = `v`.`id`'
    );
  });

  it('oracle emits a MERGE using FROM dual (no AS aliases)', function () {
    const { sql } = sqlFor('oracledb', 'id', ['name', 'age'], rows);
    expect(sql).to.equal(
      'merge into "users" tgt using (select ? "id", ? "name", ? "age" from dual ' +
        'union all select ?, ?, ? from dual) "v" on ("tgt"."id" = "v"."id") ' +
        'when matched then update set "tgt"."name" = "v"."name", ' +
        '"tgt"."age" = "v"."age"'
    );
  });

  it('supports a composite key across dialects', function () {
    const composite = [
      { tenant: 9, id: 1, name: 'a' },
      { tenant: 9, id: 2, name: 'b' },
    ];
    expect(sqlFor('pg', ['tenant', 'id'], ['name'], composite).sql).to.equal(
      'update "users" set "name" = "v"."name" from ' +
        '(select ?::numeric as "tenant", ?::numeric as "id", ?::text as "name" ' +
        'union all select ?, ?, ?) as "v" ' +
        'where "users"."tenant" = "v"."tenant" and "users"."id" = "v"."id"'
    );
    expect(sqlFor('mysql', ['tenant', 'id'], ['name'], composite).sql).to.equal(
      'update `users` inner join (select ? as `tenant`, ? as `id`, ? as `name` ' +
        'union all select ?, ?, ?) as `src` on `users`.`tenant` = `src`.`tenant` ' +
        'and `users`.`id` = `src`.`id` set `users`.`name` = `src`.`name`'
    );
    expect(
      sqlFor('oracledb', ['tenant', 'id'], ['name'], composite).sql
    ).to.contain(
      'on ("tgt"."tenant" = "v"."tenant" and "tgt"."id" = "v"."id")'
    );
  });

  it('appends RETURNING on postgres only', function () {
    const single = [{ id: 1, name: 'a' }];
    const knex = clients['pg'];
    const { sql } = buildBatchUpdateQuery(
      knex,
      'users',
      ['id'],
      ['name'],
      single,
      ['id', 'updated_at']
    ).toSQL();
    expect(sql).to.contain('returning "id", "updated_at"');

    for (const client of ['mysql', 'sqlite3', 'redshift', 'oracledb']) {
      const knexC = clients[client];
      expect(() =>
        buildBatchUpdateQuery(knexC, 'users', ['id'], ['name'], single, ['id'])
      ).to.throw(/returning\(\) is not supported/);
    }
  });

  it('throws for an unsupported dialect', function () {
    const fakeQb = { client: { dialect: 'firebird' } };
    expect(() =>
      buildBatchUpdateQuery(fakeQb, 'users', ['id'], ['name'], rows)
    ).to.throw(/is not supported for firebird/);
  });

  describe('input validation', function () {
    it('rejects ragged rows (different column sets)', function () {
      expect(() =>
        updatableColumns([{ id: 1, name: 'a' }, { id: 2 }], ['id'])
      ).to.throw(/every row must have the key column/);
    });

    it('rejects rows with no non-key columns', function () {
      expect(() => updatableColumns([{ id: 1 }], ['id'])).to.throw(
        /no non-key columns/
      );
    });

    it('rejects a bad chunkSize', function () {
      expect(() => clients['pg'].batchUpdate('users', rows, 'id', 0)).to.throw(
        /Invalid chunkSize/
      );
    });

    it('rejects a non-array batch', function () {
      expect(() => clients['pg'].batchUpdate('users', 'nope')).to.throw(
        /Invalid batch/
      );
    });

    it('rejects an invalid key', function () {
      expect(() => clients['pg'].batchUpdate('users', rows, 123)).to.throw(
        /Invalid key/
      );
    });
  });
});
