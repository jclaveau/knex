'use strict';

const { expect } = require('chai');
const knexLib = require('../../knex');
const {
  prepareBatch,
  resolveColumnTypesFromDb,
} = require('../../lib/execution/batch-update');

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

  it('postgres emits UPDATE ... FROM (SELECT ...) with first-row casts', function () {
    const { sql, bindings } = clients['pg']('users')
      .batchUpdate(rows, ['id'], ['name', 'age'])
      .toSQL();
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
    expect(
      clients['cockroachdb']('users')
        .batchUpdate(rows, ['id'], ['name', 'age'])
        .toSQL().sql
    ).to.equal(expected);
    expect(
      clients['redshift']('users')
        .batchUpdate(rows, ['id'], ['name', 'age'])
        .toSQL().sql
    ).to.equal(expected);
  });

  it('mysql emits UPDATE ... JOIN (derived) SET', function () {
    const { sql, bindings } = clients['mysql']('users')
      .batchUpdate(rows, ['id'], ['name', 'age'])
      .toSQL();
    expect(sql).to.equal(
      'update `users` inner join (select ? as `id`, ? as `name`, ? as `age` ' +
        'union all select ?, ?, ?) as `src` on `users`.`id` = `src`.`id` ' +
        'set `users`.`name` = `src`.`name`, `users`.`age` = `src`.`age`'
    );
    expect(bindings).to.eql([1, 'a', 10, 2, 'b', 20]);
  });

  it('mssql emits UPDATE ... FROM (SELECT ...) with the @@rowcount tail', function () {
    const { sql } = clients['mssql']('users')
      .batchUpdate(rows, ['id'], ['name', 'age'])
      .toSQL();
    expect(sql).to.equal(
      'update [users] set [name] = [v].[name], [age] = [v].[age] from ' +
        '(select ? as [id], ? as [name], ? as [age] union all select ?, ?, ?) ' +
        'as [v] where [users].[id] = [v].[id];select @@rowcount'
    );
  });

  it('sqlite emits UPDATE ... FROM (SELECT ...) without casts', function () {
    const { sql } = clients['sqlite3']('users')
      .batchUpdate(rows, ['id'], ['name', 'age'])
      .toSQL();
    expect(sql).to.equal(
      'update `users` set `name` = `v`.`name`, `age` = `v`.`age` from ' +
        '(select ? as `id`, ? as `name`, ? as `age` union all select ?, ?, ?) ' +
        'as `v` where `users`.`id` = `v`.`id`'
    );
  });

  it('oracle emits a MERGE using FROM dual (no AS aliases)', function () {
    const { sql } = clients['oracledb']('users')
      .batchUpdate(rows, ['id'], ['name', 'age'])
      .toSQL();
    expect(sql).to.equal(
      'merge into "users" "tgt" using (select ? "id", ? "name", ? "age" from dual ' +
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
    expect(
      clients['pg']('users')
        .batchUpdate(composite, ['tenant', 'id'], ['name'])
        .toSQL().sql
    ).to.equal(
      'update "users" set "name" = "v"."name" from ' +
        '(select ?::numeric as "tenant", ?::numeric as "id", ?::text as "name" ' +
        'union all select ?, ?, ?) as "v" ' +
        'where "users"."tenant" = "v"."tenant" and "users"."id" = "v"."id"'
    );
    expect(
      clients['mysql']('users')
        .batchUpdate(composite, ['tenant', 'id'], ['name'])
        .toSQL().sql
    ).to.equal(
      'update `users` inner join (select ? as `tenant`, ? as `id`, ? as `name` ' +
        'union all select ?, ?, ?) as `src` on `users`.`tenant` = `src`.`tenant` ' +
        'and `users`.`id` = `src`.`id` set `users`.`name` = `src`.`name`'
    );
    expect(
      clients['oracledb']('users')
        .batchUpdate(composite, ['tenant', 'id'], ['name'])
        .toSQL().sql
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

  it('infers a postgres cast for each JS value type', function () {
    const { sql } = clients['pg']('users')
      .batchUpdate(
        [
          {
            id: 1,
            flag: true,
            when: new Date(),
            buf: Buffer.from('x'),
            doc: { a: 1 },
            note: 'hi',
          },
        ],
        ['id'],
        ['flag', 'when', 'buf', 'doc', 'note']
      )
      .toSQL();
    expect(sql).to.contain('?::numeric as "id"');
    expect(sql).to.contain('?::boolean as "flag"');
    expect(sql).to.contain('?::timestamptz as "when"');
    expect(sql).to.contain('?::bytea as "buf"');
    expect(sql).to.contain('?::jsonb as "doc"');
    expect(sql).to.contain('?::text as "note"');
  });

  it('resolves to an empty result for an empty batch', async function () {
    expect(await clients['pg'].batchUpdate('users', [])).to.eql([]);
  });

  it('accepts a scalar returning column (postgres)', function () {
    const { sql } = clients['pg']('users')
      .batchUpdate([{ id: 1, name: 'a' }], ['id'], ['name'])
      .returning('name') // scalar, not an array
      .toSQL();
    expect(sql).to.contain('returning "users"."name"');
  });

  it('casts from the first non-null value, else text (postgres)', function () {
    // first row null for `n` -> skip it, infer from the next row
    const inferred = clients['pg']('users')
      .batchUpdate(
        [
          { id: 1, n: null },
          { id: 2, n: 5 },
        ],
        ['id'],
        ['n']
      )
      .toSQL().sql;
    expect(inferred).to.contain('?::numeric as "n"');
    // all-null column -> text fallback
    const allNull = clients['pg']('users')
      .batchUpdate([{ id: 1, n: null }], ['id'], ['n'])
      .toSQL().sql;
    expect(allNull).to.contain('?::text as "n"');
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

  describe("mode: 'case'", function () {
    it('emits one CASE per column keyed on the row, IN-list WHERE', function () {
      const { sql, bindings } = clients['pg']('users')
        .batchUpdate(rows, ['id'], ['name', 'age'], undefined, 'case')
        .toSQL();
      expect(sql).to.equal(
        'update "users" set ' +
          '"name" = case when "users"."id" = ? then ? ' +
          'when "users"."id" = ? then ? else "name" end, ' +
          '"age" = case when "users"."id" = ? then ? ' +
          'when "users"."id" = ? then ? else "age" end ' +
          'where "users"."id" in (?, ?)'
      );
      // no ::casts: values sit in assignment context, typed by the column
      expect(sql).to.not.contain('::');
      expect(bindings).to.eql([1, 'a', 2, 'b', 1, 10, 2, 20, 1, 2]);
    });

    it('AND-joins a composite key in both the CASE and the WHERE', function () {
      const { sql } = clients['pg']('users')
        .batchUpdate(
          [{ tenant: 9, id: 1, name: 'a' }],
          ['tenant', 'id'],
          ['name'],
          undefined,
          'case'
        )
        .toSQL();
      expect(sql).to.contain(
        'when ("users"."tenant" = ? and "users"."id" = ?) then ?'
      );
      expect(sql).to.contain(
        'where ("users"."tenant" = ? and "users"."id" = ?)'
      );
    });

    it('is identical across dialects (no per-dialect form)', function () {
      const sqlFor = (client) =>
        clients[client]('users')
          .batchUpdate(rows, ['id'], ['name', 'age'], undefined, 'case')
          .toSQL()
          .sql.replace(/["`[\]]/g, ''); // strip identifier quoting to compare
      const pg = sqlFor('pg');
      for (const client of ['mysql', 'sqlite3', 'oracledb', 'cockroachdb']) {
        expect(sqlFor(client)).to.equal(pg);
      }
    });

    it('appends @@rowcount on mssql', function () {
      const { sql } = clients['mssql']('users')
        .batchUpdate(rows, ['id'], ['name', 'age'], undefined, 'case')
        .toSQL();
      expect(sql).to.contain('select @@rowcount');
    });

    it('rejects .returning() (union only)', function () {
      expect(() =>
        clients['pg']('users')
          .batchUpdate(rows, ['id'], ['name'], undefined, 'case')
          .returning(['id'])
          .toSQL()
      ).to.throw(/only supported with mode 'union'/);
    });
  });

  describe("mode: 'json'", function () {
    it('postgres expands one jsonb param via jsonb_populate_recordset over the table row type', function () {
      const threeRows = [
        { id: 1, name: 'a', age: 10 },
        { id: 2, name: 'b', age: 20 },
        { id: 3, name: 'c', age: 30 },
      ];
      const { sql, bindings } = clients['pg']('users')
        .batchUpdate(threeRows, ['id'], ['name', 'age'], undefined, 'json')
        .toSQL();
      expect(sql).to.equal(
        'update "users" set "name" = "v"."name", "age" = "v"."age" ' +
          'from jsonb_populate_recordset(null::"users", ?) as "v" ' +
          'where "users"."id" = "v"."id"'
      );
      // one parameter for the WHOLE chunk regardless of row count
      expect(bindings).to.have.lengthOf(1);
      expect(JSON.parse(bindings[0])).to.eql(threeRows);
    });

    describe('postgres binds each value as node-pg binds it in .update()', function () {
      const pgDefaults = require('pg').defaults;
      let savedTimezone;
      let savedDatesAsUtc;

      beforeEach(function () {
        savedTimezone = process.env.TZ;
        savedDatesAsUtc = pgDefaults.parseInputDatesAsUTC;
        process.env.TZ = 'Europe/Paris';
      });

      afterEach(function () {
        // Assigning undefined would store the string 'undefined', i.e. UTC.
        if (savedTimezone === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = savedTimezone;
        }
        pgDefaults.parseInputDatesAsUTC = savedDatesAsUtc;
      });

      it('binds a Date in local time with its offset', function () {
        const { bindings } = clients['pg']('posts')
          .batchUpdate(
            [{ id: 1, published: new Date('2026-07-01T08:00:00.000Z') }],
            ['id'],
            ['published'],
            undefined,
            'json'
          )
          .toSQL();
        expect(bindings).to.eql([
          '[{"id":1,"published":"2026-07-01T10:00:00.000+02:00"}]',
        ]);
      });

      it('binds a Date in UTC under parseInputDatesAsUTC', function () {
        pgDefaults.parseInputDatesAsUTC = true;
        const { bindings } = clients['pg']('posts')
          .batchUpdate(
            [{ id: 1, published: new Date('2026-07-01T08:00:00.000Z') }],
            ['id'],
            ['published'],
            undefined,
            'json'
          )
          .toSQL();
        expect(bindings).to.eql([
          '[{"id":1,"published":"2026-07-01T08:00:00.000+00:00"}]',
        ]);
      });

      it('binds a bigint and a non-finite number as text', function () {
        const { bindings } = clients['pg']('posts')
          .batchUpdate(
            [
              { id: 1, views: 9007199254740993n, score: NaN },
              { id: 2, views: 3n, score: Infinity },
            ],
            ['id'],
            ['views', 'score'],
            undefined,
            'json'
          )
          .toSQL();
        expect(bindings).to.eql([
          '[{"id":1,"views":"9007199254740993","score":"NaN"},' +
            '{"id":2,"views":"3","score":"Infinity"}]',
        ]);
      });

      it('binds a Date when the client driver is replaced', function () {
        const knex = knexLib({ client: 'pg' });
        knex.client.driver = { tracker: {} };
        const { bindings } = knex('posts')
          .batchUpdate(
            [{ id: 1, published: new Date('2026-07-01T08:00:00.000Z') }],
            ['id'],
            ['published'],
            undefined,
            'json'
          )
          .toSQL();
        knex.destroy();
        expect(bindings).to.eql([
          '[{"id":1,"published":"2026-07-01T10:00:00.000+02:00"}]',
        ]);
      });
    });

    it('postgres keys each JSON row by the wrapIdentifier column name', function () {
      const knex = knexLib({
        client: 'pg',
        wrapIdentifier: (value, origImpl) =>
          origImpl(value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)),
      });
      const { sql, bindings } = knex('users')
        .batchUpdate(
          [{ id: 1, firstName: 'new' }],
          ['id'],
          ['firstName'],
          undefined,
          'json'
        )
        .toSQL();
      knex.destroy();
      expect(sql).to.equal(
        'update "users" set "first_name" = "v"."first_name" ' +
          'from jsonb_populate_recordset(null::"users", ?) as "v" ' +
          'where "users"."id" = "v"."id"'
      );
      expect(bindings).to.eql(['[{"id":1,"first_name":"new"}]']);
    });

    it('cockroachdb reuses the postgres jsonb_populate_recordset form', function () {
      const { sql } = clients['cockroachdb']('users')
        .batchUpdate(rows, ['id'], ['name', 'age'], undefined, 'json')
        .toSQL();
      expect(sql).to.equal(
        'update "users" set "name" = "v"."name", "age" = "v"."age" ' +
          'from jsonb_populate_recordset(null::"users", ?) as "v" ' +
          'where "users"."id" = "v"."id"'
      );
    });

    it('takes the row type of a schema-qualified table and qualifies RETURNING (postgres)', function () {
      const { sql } = clients['pg']('public.articles')
        .batchUpdate(
          [{ id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', status: 'draft' }],
          ['id'],
          ['status'],
          undefined,
          'json'
        )
        .returning(['id'])
        .toSQL();
      expect(sql).to.equal(
        'update "public"."articles" set "status" = "v"."status" ' +
          'from jsonb_populate_recordset(null::"public"."articles", ?) as "v" ' +
          'where "public"."articles"."id" = "v"."id" ' +
          'returning "public"."articles"."id"'
      );
    });

    it('sqlite expands json_each into an UPDATE ... FROM source', function () {
      const { sql } = clients['sqlite3']('users')
        .batchUpdate(
          [{ id: 1, name: 'a' }],
          ['id'],
          ['name'],
          undefined,
          'json'
        )
        .toSQL();
      expect(sql).to.equal(
        'update `users` set `name` = `v`.`name` from ' +
          '(select json_extract(value, ?) as `id`, ' +
          'json_extract(value, ?) as `name` from json_each(?)) as `v` ' +
          'where `users`.`id` = `v`.`id`'
      );
    });

    it('mysql expands one JSON param via JSON_TABLE with a typed COLUMNS list', function () {
      const { sql, bindings } = clients['mysql']('users')
        .batchUpdate(
          [{ id: 1, name: 'a', age: 10 }],
          ['id'],
          ['name', 'age'],
          { id: 'int', name: 'char(50)', age: 'int' },
          'json'
        )
        .toSQL();
      expect(sql).to.equal(
        'update `users` inner join json_table(?, ' +
          "'$[*]' columns (`id` int path '$.id', " +
          "`name` char(50) path '$.name', `age` int path '$.age')) " +
          'as `src` on `users`.`id` = `src`.`id` ' +
          'set `users`.`name` = `src`.`name`, `users`.`age` = `src`.`age`'
      );
      expect(bindings).to.have.lengthOf(1);
      expect(JSON.parse(bindings[0])).to.eql([{ id: 1, name: 'a', age: 10 }]);
    });

    it('mssql expands one JSON param via OPENJSON ... WITH and keeps the @@rowcount tail', function () {
      const { sql, bindings } = clients['mssql']('users')
        .batchUpdate(
          [{ id: 1, name: 'a', age: 10 }],
          ['id'],
          ['name', 'age'],
          { id: 'int', name: 'nvarchar(50)', age: 'int' },
          'json'
        )
        .toSQL();
      expect(sql).to.equal(
        'update [users] set [name] = [src].[name], [age] = [src].[age] ' +
          "from openjson(?) with ([id] int '$.id', " +
          "[name] nvarchar(50) '$.name', [age] int '$.age') as [src] " +
          'where [users].[id] = [src].[id];select @@rowcount'
      );
      expect(bindings).to.have.lengthOf(1);
    });

    it('oracle expands one JSON param via JSON_TABLE inside a MERGE', function () {
      const { sql, bindings } = clients['oracledb']('users')
        .batchUpdate(
          [{ id: 1, name: 'a', age: 10 }],
          ['id'],
          ['name', 'age'],
          { id: 'number', name: 'varchar2(50)', age: 'number' },
          'json'
        )
        .toSQL();
      expect(sql).to.equal(
        'merge into "users" "tgt" using (select * from json_table(to_clob(?), ' +
          "'$[*]' columns (\"id\" number path '$.id', " +
          '"name" varchar2(50) path \'$.name\', "age" number path \'$.age\'))) ' +
          '"v" on ("tgt"."id" = "v"."id") when matched then update set ' +
          '"tgt"."name" = "v"."name", "tgt"."age" = "v"."age"'
      );
      // small payload -> a single to_clob(?) piece
      expect(bindings).to.have.lengthOf(1);
    });

    it('requires an explicit columnTypes map for JSON_TABLE/OPENJSON dialects', function () {
      for (const client of ['mysql', 'mssql', 'oracledb']) {
        expect(() =>
          clients[client]('users')
            .batchUpdate(
              [{ id: 1, name: 'a' }],
              ['id'],
              ['name'],
              undefined,
              'json'
            )
            .toSQL()
        ).to.throw(/needs an explicit columnTypes map/);
      }
    });

    it('splits a large oracle json payload into concatenated to_clob binds', function () {
      // > 4000 bytes of JSON: Oracle would bind that as LONG (ORA-01461), so the
      // payload is split into <=4000-byte VARCHAR2 pieces rebuilt as a CLOB via
      // to_clob(?) || to_clob(?) ... — JSON_TABLE accepts the CLOB.
      const wide = [];
      for (let id = 1; id <= 400; id++) {
        wide.push({ id, name: `name-value-${id}` });
      }
      const { sql, bindings } = clients['oracledb']('users')
        .batchUpdate(
          wide,
          ['id'],
          ['name'],
          { id: 'number', name: 'varchar2(50)' },
          'json'
        )
        .toSQL();
      expect(sql).to.contain('to_clob(?) || to_clob(?)');
      expect(sql).to.contain('json_table(to_clob(?)');
      // multiple pieces, each under the 4000-byte VARCHAR2 limit
      expect(bindings.length).to.be.greaterThan(1);
      for (const piece of bindings) {
        expect(Buffer.byteLength(piece)).to.be.at.most(4000);
      }
      // the pieces concatenate back to the exact JSON payload
      expect(JSON.parse(bindings.join(''))).to.eql(wide);
    });

    it('throws on dialects without a json-rowset function', function () {
      expect(() =>
        clients['redshift']('users')
          .batchUpdate(
            [{ id: 1, name: 'a' }],
            ['id'],
            ['name'],
            undefined,
            'json'
          )
          .toSQL()
      ).to.throw(/'json' is not supported/);
    });
  });

  describe('input validation', function () {
    it('rejects ragged rows (different column sets)', function () {
      expect(() =>
        prepareBatch([{ id: 1, name: 'a' }, { id: 2 }], ['id'], 'last')
      ).to.throw(/every row must have the key column/);
    });

    it('leaves out a column undefined in every row, as .update() does', function () {
      expect(
        prepareBatch(
          [
            { id: 1, name: 'a', age: undefined },
            { id: 2, name: 'b', age: undefined },
          ],
          ['id'],
          'last'
        ).columns
      ).to.eql(['name']);
    });

    it('rejects a column undefined in some rows only', function () {
      expect(() =>
        prepareBatch(
          [
            { id: 1, name: 'a', age: 10 },
            { id: 2, name: 'b', age: undefined },
          ],
          ['id'],
          'last'
        )
      )
        .to.throw(TypeError)
        .with.property(
          'message',
          'Invalid batch: age is undefined in some rows only; one SET clause writes it in every row, so set it to null or leave it out of every row'
        );
    });

    it('rejects rows whose every non-key column is undefined', function () {
      expect(() => prepareBatch([{ id: 1, name: undefined }], ['id'], 'last'))
        .to.throw(TypeError)
        .with.property(
          'message',
          'Invalid batch: rows have no non-key columns to update'
        );
    });

    it('rejects rows with no non-key columns', function () {
      expect(() => prepareBatch([{ id: 1 }], ['id'], 'last')).to.throw(
        /no non-key columns/
      );
    });

    it('collapses a duplicate composite key holding a bigint', function () {
      expect(
        prepareBatch(
          [
            { tenant: 1n, id: 2, name: 'a' },
            { tenant: 1n, id: 2, name: 'b' },
          ],
          ['tenant', 'id'],
          'last'
        )
      ).to.eql({ columns: ['name'], rows: [{ tenant: 1n, id: 2, name: 'b' }] });
    });

    it('names a duplicate composite key holding a bigint', function () {
      expect(() =>
        prepareBatch(
          [
            { tenant: 1n, id: 2, name: 'a' },
            { tenant: 1n, id: 2, name: 'b' },
          ],
          ['tenant', 'id'],
          'throw'
        )
      )
        .to.throw(Error)
        .with.property(
          'message',
          `Invalid batch: duplicate key ["1",2] (use onDuplicateKey: 'last' to keep the last row instead)`
        );
    });

    it('rejects a NaN chunkSize', function () {
      expect(() =>
        clients['pg'].batchUpdate('users', rows, 'id', { chunkSize: NaN })
      )
        .to.throw(TypeError)
        .with.property('message', 'Invalid chunkSize: NaN');
    });

    it('rejects a bad chunkSize', function () {
      expect(() =>
        clients['pg'].batchUpdate('users', rows, 'id', { chunkSize: 0 })
      ).to.throw(/Invalid chunkSize/);
    });

    it('rejects a non-array batch', function () {
      expect(() => clients['pg'].batchUpdate('users', 'nope')).to.throw(
        /Invalid batch/
      );
    });

    it("rejects a columnTypes map in 'json' mode on the postgres family", function () {
      for (const dialect of ['pg', 'cockroachdb']) {
        expect(() =>
          clients[dialect].batchUpdate('users', rows, 'id', {
            mode: 'json',
            columnTypes: { name: 'text' },
          })
        )
          .to.throw(TypeError)
          .with.property(
            'message',
            "columnTypes has no effect in 'json' mode on postgres: the column types come from the table row type"
          );
      }
    });

    it("rejects columnTypes 'from_db' in 'json' mode on postgres before any query", function () {
      expect(() =>
        clients['pg'].batchUpdate('users', rows, 'id', {
          mode: 'json',
          columnTypes: 'from_db',
        })
      )
        .to.throw(TypeError)
        .with.property(
          'message',
          "columnTypes has no effect in 'json' mode on postgres: the column types come from the table row type"
        );
    });

    it("accepts columnTypes 'from_data' in 'json' mode on postgres", function () {
      expect(() =>
        clients['pg']
          .batchUpdate('users', rows, 'id', {
            mode: 'json',
            columnTypes: 'from_data',
          })
          .catch(() => {})
      ).to.not.throw();
    });

    it("rejects columnTypes in 'case' mode (nothing to cast)", function () {
      expect(() =>
        clients['pg'].batchUpdate('users', rows, 'id', {
          mode: 'case',
          columnTypes: { name: 'text' },
        })
      ).to.throw(/columnTypes has no effect in 'case' mode/);
    });

    it('rejects an invalid mode', function () {
      expect(() =>
        clients['pg'].batchUpdate('users', rows, 'id', { mode: 'bogus' })
      ).to.throw(/Invalid mode/);
    });

    it('rejects an invalid key', function () {
      expect(() => clients['pg'].batchUpdate('users', rows, 123)).to.throw(
        /Invalid key/
      );
    });

    it('rejects an invalid onDuplicateKey option', function () {
      expect(() =>
        clients['pg'].batchUpdate('users', rows, 'id', {
          onDuplicateKey: 'nope',
        })
      ).to.throw(/Invalid onDuplicateKey/);
    });

    it('rejects a non-object columnTypes option', function () {
      expect(() =>
        clients['pg'].batchUpdate('users', rows, 'id', {
          columnTypes: 'nope',
        })
      ).to.throw(/Invalid columnTypes/);
    });

    it('rejects a columnTypes value that is not a safe type name', function () {
      expect(() =>
        clients['pg'].batchUpdate('users', rows, 'id', {
          columnTypes: { name: 'text); drop table users; --' },
        })
      ).to.throw(/Invalid columnTypes\.name/);
    });

    it('interpolates parameterized and array type names into the casts', function () {
      for (const type of [
        'text[]',
        'varchar(255)',
        'numeric(10, 2)',
        'timestamp(3) with time zone',
        '"public"."mood"[]',
      ]) {
        const { sql } = clients['pg']('users')
          .batchUpdate(rows, ['id'], ['name', 'age'], { name: type })
          .toSQL();
        expect(sql).to.contain(`?::${type} as "name"`);
      }
    });

    it("throws when 'from_db' reads a type that is not a valid type name", async function () {
      const dialectClient = {
        batchUpdateColumnTypesFromDb: async () => ({
          id: 'integer',
          mood: 'USER-DEFINED',
        }),
      };
      let error;
      try {
        await resolveColumnTypesFromDb(dialectClient, null, 'users', [
          'id',
          'mood',
        ]);
      } catch (caught) {
        error = caught;
      }
      expect(error.message).to.equal(
        `columnTypes 'from_db': column mood has type "USER-DEFINED", which is not a valid type name; pass an explicit columnTypes entry for it`
      );
    });

    it("throws when 'from_db' finds no type for a column", async function () {
      const dialectClient = {
        batchUpdateColumnTypesFromDb: async () => ({ id: 'integer' }),
      };
      let error;
      try {
        await resolveColumnTypesFromDb(dialectClient, null, 'users', [
          'id',
          'mood',
        ]);
      } catch (caught) {
        error = caught;
      }
      expect(error.message).to.equal(
        `columnTypes 'from_db': users has no column mood`
      );
    });

    it("accepts the 'from_data' and 'from_db' columnTypes strategies", function () {
      // These strategies resolve in the executor (from_db reads columnInfo), so
      // they can't be asserted via toSQL here — only that the synchronous option
      // validation accepts them. Real SQL/DML coverage is in the integration suite.
      for (const columnTypes of ['from_data', 'from_db']) {
        expect(() =>
          clients['pg']
            .batchUpdate('users', rows, 'id', { columnTypes })
            .catch(() => {})
        ).to.not.throw();
      }
    });

    it('rejects an unknown columnTypes string', function () {
      expect(() =>
        clients['pg'].batchUpdate('users', rows, 'id', {
          columnTypes: 'from_nowhere',
        })
      ).to.throw(/Invalid columnTypes/);
    });

    it('throws when columnTypes is used on a non-postgres dialect', function () {
      for (const client of ['mysql', 'sqlite3', 'mssql', 'oracledb']) {
        expect(() =>
          clients[client]('users')
            .batchUpdate(rows, ['id'], ['name', 'age'], { name: 'text' })
            .toSQL()
        ).to.throw(/columnTypes is only supported on the postgres family/);
      }
    });

    it('each dialect declares its bind-parameter ceiling (drives chunk capping)', function () {
      const expected = {
        pg: 65535,
        cockroachdb: 65535,
        redshift: 65535,
        mysql: 65535,
        oracledb: 65535,
        sqlite3: 32766,
        mssql: 2098,
      };
      for (const [client, limit] of Object.entries(expected)) {
        expect(clients[client].client.maxBindParameters).to.equal(limit);
      }
    });

    it('throws on Redshift for bytea/jsonb casts it has no type for', function () {
      expect(() =>
        clients['redshift']('users')
          .batchUpdate([{ id: 1, doc: { a: 1 } }], ['id'], ['doc'])
          .toSQL()
      ).to.throw(/Redshift has no jsonb type/);
      expect(() =>
        clients['redshift']('users')
          .batchUpdate([{ id: 1, buf: Buffer.from('x') }], ['id'], ['buf'])
          .toSQL()
      ).to.throw(/Redshift has no bytea type/);
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
