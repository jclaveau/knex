'use strict';

const { expect } = require('chai');
const knexLib = require('../../knex');
const { prepareBatch } = require('../../lib/execution/batch-update');

// Per-dialect SQL generation for batchUpdate, asserted via toSQL() without a
// live database. Behavioural (real DML) coverage lives in the integration suite.
// The SQL is produced by each dialect's QueryCompiler#batchUpdate, reached
// through the builder method knex(table).batchUpdate(rows, keyColumns, columns).
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
    return clients[client]('users')
      .batchUpdate(batch, Array.isArray(key) ? key : [key], columns)
      .toSQL();
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

  it('cockroachdb and redshift reuse the postgres FROM form', function () {
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

  it('mssql emits UPDATE ... FROM (SELECT ...) with the @@rowcount tail', function () {
    const { sql } = sqlFor('mssql', 'id', ['name', 'age'], rows);
    expect(sql).to.equal(
      'update [users] set [name] = [v].[name], [age] = [v].[age] from ' +
        '(select ? as [id], ? as [name], ? as [age] union all select ?, ?, ?) ' +
        'as [v] where [users].[id] = [v].[id];select @@rowcount'
    );
  });

  it('sqlite emits UPDATE ... FROM (SELECT ...) without casts', function () {
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

  it('appends a target-qualified RETURNING on postgres', function () {
    const { sql } = clients['pg']('users')
      .batchUpdate([{ id: 1, name: 'a' }], ['id'], ['name'])
      .returning(['id', 'updated_at'])
      .toSQL();
    // qualified to disambiguate from the FROM source which shares "id"
    expect(sql).to.contain('returning "users"."id", "users"."updated_at"');
  });

  it('infers bigint and honors the columnTypes override (postgres)', function () {
    const { sql } = clients['pg']('users')
      .batchUpdate([{ id: 1n, tags: ['a'] }], ['id'], ['tags'], {
        tags: 'text[]',
      })
      .toSQL();
    // bigint value inferred; tags cast taken from columnTypes
    expect(sql).to.contain('?::bigint as "id"');
    expect(sql).to.contain('?::text[] as "tags"');
  });

  it('throws for .returning() on dialects without it', function () {
    for (const client of ['mysql', 'sqlite3', 'redshift', 'oracledb']) {
      expect(() =>
        clients[client]('users')
          .batchUpdate([{ id: 1, name: 'a' }], ['id'], ['name'])
          .returning(['id'])
          .toSQL()
      ).to.throw(/returning\(\) is not supported/);
    }
  });

  describe('input validation', function () {
    it('rejects ragged rows (different column sets)', function () {
      expect(() =>
        prepareBatch([{ id: 1, name: 'a' }, { id: 2 }], ['id'], 'last')
      ).to.throw(/every row must have the key column/);
    });

    it('rejects rows with no non-key columns', function () {
      expect(() => prepareBatch([{ id: 1 }], ['id'], 'last')).to.throw(
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

    it('rejects an invalid onDuplicateKey option', function () {
      expect(() =>
        clients['pg'].batchUpdate('users', rows, 'id', 1000, {
          onDuplicateKey: 'nope',
        })
      ).to.throw(/Invalid onDuplicateKey/);
    });

    it('rejects a non-object columnTypes option', function () {
      expect(() =>
        clients['pg'].batchUpdate('users', rows, 'id', 1000, {
          columnTypes: 'nope',
        })
      ).to.throw(/Invalid columnTypes/);
    });
  });

  describe('duplicate keys', function () {
    it('keeps the last row per key by default (last-write-wins)', function () {
      expect(
        prepareBatch(
          [
            { id: 1, v: 'a' },
            { id: 1, v: 'b' },
            { id: 2, v: 'c' },
          ],
          ['id'],
          'last'
        ).rows
      ).to.eql([
        { id: 1, v: 'b' },
        { id: 2, v: 'c' },
      ]);
    });

    it('dedupes on the full composite key', function () {
      expect(
        prepareBatch(
          [
            { tenant: 7, id: 1, v: 'a' },
            { tenant: 8, id: 1, v: 'b' }, // same id, different tenant — kept
            { tenant: 7, id: 1, v: 'c' }, // collides with the first — last wins
          ],
          ['tenant', 'id'],
          'last'
        ).rows
      ).to.eql([
        { tenant: 7, id: 1, v: 'c' },
        { tenant: 8, id: 1, v: 'b' },
      ]);
    });

    it('throws on a duplicate key when requested', function () {
      expect(() =>
        prepareBatch(
          [
            { id: 1, v: 'a' },
            { id: 1, v: 'b' },
          ],
          ['id'],
          'throw'
        )
      ).to.throw(/duplicate key/);
    });
  });
});
