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
        '(select ?::bigint as "id", ?::text as "name", ?::bigint as "age" ' +
        'union all select ?, ?, ?) as "v" where "users"."id" = "v"."id"'
    );
    expect(bindings).to.eql([1, 'a', 10, 2, 'b', 20]);
  });

  it('cockroachdb and redshift reuse the postgres FROM form', function () {
    const expected =
      'update "users" set "name" = "v"."name", "age" = "v"."age" from ' +
      '(select ?::bigint as "id", ?::text as "name", ?::bigint as "age" ' +
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
        '(select ?::bigint as "tenant", ?::bigint as "id", ?::text as "name" ' +
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
    expect(sql).to.contain('?::bigint as "id"');
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
    expect(inferred).to.contain('?::bigint as "n"');
    // all-null column -> text fallback
    const allNull = clients['pg']('users')
      .batchUpdate([{ id: 1, n: null }], ['id'], ['n'])
      .toSQL().sql;
    expect(allNull).to.contain('?::text as "n"');
  });

  it('casts a number column holding a fraction to numeric (postgres)', function () {
    expect(
      clients['pg']('users')
        .batchUpdate(
          [
            { id: 1, n: 1 },
            { id: 2, n: 1.5 },
          ],
          ['id'],
          ['n']
        )
        .toSQL().sql
    ).to.equal(
      'update "users" set "n" = "v"."n" from (select ?::bigint as "id", ?::numeric as "n" union all select ?, ?) as "v" where "users"."id" = "v"."id"'
    );
  });

  it('casts a raw first-row cell whole in union mode (postgres)', function () {
    const knex = clients['pg'];
    expect(
      knex('users')
        .batchUpdate(
          [
            { id: 1, age: knex.raw('40 + 2'), seen: knex.fn.now() },
            { id: 2, age: 3, seen: new Date(0) },
          ],
          ['id'],
          ['age', 'seen']
        )
        .toSQL()
        .toNative()
    ).to.eql({
      sql: 'update "users" set "age" = "v"."age", "seen" = "v"."seen" from (select $1::bigint as "id", (40 + 2)::bigint as "age", (CURRENT_TIMESTAMP)::timestamptz as "seen" union all select $2, $3, $4) as "v" where "users"."id" = "v"."id"',
      bindings: [1, 2, 3, new Date(0)],
    });
  });

  it('types a raw cell from the bound values of later rows (postgres)', function () {
    const knex = clients['pg'];
    expect(
      knex('users')
        .batchUpdate(
          [
            { id: 1, n: knex.raw('1 + 1') },
            { id: 2, n: 1.5 },
          ],
          ['id'],
          ['n']
        )
        .toSQL()
        .toNative()
    ).to.eql({
      sql: 'update "users" set "n" = "v"."n" from (select $1::bigint as "id", (1 + 1)::numeric as "n" union all select $2, $3) as "v" where "users"."id" = "v"."id"',
      bindings: [1, 2, 1.5],
    });
  });

  it('casts a raw cell in a later row (postgres)', function () {
    const knex = clients['pg'];
    expect(
      knex('users')
        .batchUpdate(
          [
            { id: 1, s: 'a' },
            { id: 2, s: knex.raw('now()') },
          ],
          ['id'],
          ['s']
        )
        .toSQL()
        .toNative()
    ).to.eql({
      sql: 'update "users" set "s" = "v"."s" from (select $1::bigint as "id", $2::text as "s" union all select $3, (now())::text) as "v" where "users"."id" = "v"."id"',
      bindings: [1, 'a', 2],
    });
  });

  it('casts a raw cell to its columnTypes entry (postgres)', function () {
    const knex = clients['pg'];
    expect(
      knex('users')
        .batchUpdate(
          [
            { id: 1, i: knex.raw("'4'") },
            { id: 2, i: 5 },
          ],
          ['id'],
          ['i'],
          { i: 'integer' }
        )
        .toSQL()
        .toNative()
    ).to.eql({
      sql: 'update "users" set "i" = "v"."i" from (select $1::bigint as "id", (\'4\')::integer as "i" union all select $2, $3) as "v" where "users"."id" = "v"."id"',
      bindings: [1, 2, 5],
    });
  });

  it('leaves a column of raw cells and nulls uncast (postgres)', function () {
    const knex = clients['pg'];
    expect(
      knex('users')
        .batchUpdate(
          [
            { id: 1, s: knex.raw('now()') },
            { id: 2, s: null },
          ],
          ['id'],
          ['s']
        )
        .toSQL()
        .toNative()
    ).to.eql({
      sql: 'update "users" set "s" = "v"."s" from (select $1::bigint as "id", now() as "s" union all select $2, $3) as "v" where "users"."id" = "v"."id"',
      bindings: [1, 2, null],
    });
  });

  it('compiles a function value as a cast subquery (postgres)', function () {
    expect(
      clients['pg']('users')
        .batchUpdate(
          [
            {
              id: 1,
              name: function () {
                this.select('x').from('y');
              },
            },
            { id: 2, name: 'b' },
          ],
          ['id'],
          ['name']
        )
        .toSQL()
        .toNative()
    ).to.eql({
      sql: 'update "users" set "name" = "v"."name" from (select $1::bigint as "id", ((select "x" from "y"))::text as "name" union all select $2, $3) as "v" where "users"."id" = "v"."id"',
      bindings: [1, 2, 'b'],
    });
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

  it("throws for .returning() in 'json' mode on sqlite3", function () {
    expect(() =>
      clients['sqlite3']('users')
        .batchUpdate(
          [{ id: 1, name: 'a' }],
          ['id'],
          ['name'],
          undefined,
          'json'
        )
        .returning(['id'])
        .toSQL()
    )
      .to.throw(Error)
      .with.property(
        'message',
        '.batchUpdate().returning() is not supported for sqlite3'
      );
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

    it('rejects .returning()', function () {
      expect(() =>
        clients['pg']('users')
          .batchUpdate(rows, ['id'], ['name'], undefined, 'case')
          .returning(['id'])
          .toSQL()
      )
        .to.throw(Error)
        .with.property(
          'message',
          ".batchUpdate().returning() is not supported with mode 'case'"
        );
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

    it('rejects an aliased table', function () {
      expect(() =>
        clients['pg'].batchUpdate('users as u', [{ id: 1, name: 'a' }])
      )
        .to.throw(TypeError)
        .with.property(
          'message',
          'Invalid tableName: Expected a table name without an alias, got "users as u"'
        );
    });

    it('rejects a raw table', function () {
      const knex = clients['pg'];
      expect(() => knex.batchUpdate(knex.raw('users'), [{ id: 1, name: 'a' }]))
        .to.throw(TypeError)
        .with.property(
          'message',
          'Invalid tableName: Expected a table name without an alias, got object'
        );
    });

    it("rejects a raw value in 'json' mode", function () {
      const knex = clients['pg'];
      expect(() =>
        knex.batchUpdate('users', [{ id: 1, seen: knex.fn.now() }], 'id', {
          mode: 'json',
        })
      )
        .to.throw(TypeError)
        .with.property(
          'message',
          "Invalid batch: seen holds a raw value or a subquery; 'json' mode can't carry SQL, use mode 'case'"
        );
    });

    it("rejects a function value in 'json' mode", function () {
      expect(() =>
        clients['pg'].batchUpdate(
          'users',
          [
            {
              id: 1,
              name: function () {
                this.select('x').from('y');
              },
            },
          ],
          'id',
          { mode: 'json' }
        )
      )
        .to.throw(TypeError)
        .with.property(
          'message',
          "Invalid batch: name holds a raw value or a subquery; 'json' mode can't carry SQL, use mode 'case'"
        );
    });

    it("rejects a subquery value in 'json' mode", function () {
      const knex = clients['sqlite3'];
      expect(() =>
        knex.batchUpdate(
          'users',
          [{ id: 1, age: knex('ages').max('age') }],
          'id',
          { mode: 'json' }
        )
      )
        .to.throw(TypeError)
        .with.property(
          'message',
          "Invalid batch: age holds a raw value or a subquery; 'json' mode can't carry SQL, use mode 'case'"
        );
    });
    it("rejects a raw value nested in an array in 'json' mode", function () {
      const knex = clients['pg'];
      expect(() =>
        knex.batchUpdate(
          'users',
          [{ id: 1, tags: [knex.raw('now()')] }],
          'id',
          {
            mode: 'json',
          }
        )
      )
        .to.throw(TypeError)
        .with.property(
          'message',
          "Invalid batch: tags holds a raw value or a subquery; 'json' mode can't carry SQL, use mode 'case'"
        );
    });

    it("rejects a raw value nested in an object in 'json' mode", function () {
      const knex = clients['pg'];
      expect(() =>
        knex.batchUpdate(
          'users',
          [{ id: 1, meta: { seen: { at: knex.fn.now() } } }],
          'id',
          { mode: 'json' }
        )
      )
        .to.throw(TypeError)
        .with.property(
          'message',
          "Invalid batch: meta holds a raw value or a subquery; 'json' mode can't carry SQL, use mode 'case'"
        );
    });
    it("rejects a value whose toJSON returns a raw in 'json' mode", function () {
      const knex = clients['pg'];
      expect(() =>
        knex.batchUpdate(
          'users',
          [{ id: 1, meta: { toJSON: () => knex.raw('now()') } }],
          'id',
          { mode: 'json' }
        )
      )
        .to.throw(TypeError)
        .with.property(
          'message',
          "Invalid batch: meta holds a raw value or a subquery; 'json' mode can't carry SQL, use mode 'case'"
        );
    });

    it("binds a nested object through its toJSON in 'json' mode", async function () {
      const knex = knexLib({ client: 'pg' });
      const statements = [];
      knex.client.acquireConnection = async () => ({ __knexUid: 'stub' });
      knex.client.releaseConnection = async () => {};
      knex.client._query = async (connection, query) => {
        statements.push([query.sql, query.bindings]);
        return query;
      };
      knex.client.processResponse = () => [];
      await knex
        .batchUpdate(
          'users',
          [{ id: 1, meta: { seen: { toJSON: () => 1 }, format: () => 'x' } }],
          'id',
          { mode: 'json' }
        )
        .transacting(knex);
      expect(statements).to.eql([
        [
          'update "users" set "meta" = "v"."meta" from jsonb_populate_recordset(null::"users", $1) as "v" where "users"."id" = "v"."id"',
          ['[{"id":1,"meta":{"seen":1}}]'],
        ],
      ]);
    });

    it("refuses a cyclic value in 'json' mode with the circular-structure error", async function () {
      const knex = knexLib({ client: 'pg' });
      knex.client.acquireConnection = async () => ({ __knexUid: 'stub' });
      knex.client.releaseConnection = async () => {};
      knex.client._query = async (connection, query) => query;
      knex.client.processResponse = () => [];
      const meta = {};
      meta.self = meta;
      let error;
      try {
        await knex
          .batchUpdate('users', [{ id: 1, meta }], 'id', { mode: 'json' })
          .transacting(knex);
      } catch (caught) {
        error = caught;
      }
      expect(error.message).to.equal(
        "Converting circular structure to JSON\n    --> starting at object with constructor 'Object'\n    --- property 'self' closes the circle"
      );
    });

    it("names a missing column when 'json' reads the catalog for a Buffer column", async function () {
      const knex = knexLib({ client: 'pg' });
      knex.client.acquireConnection = async () => ({ __knexUid: 'stub' });
      knex.client.releaseConnection = async () => {};
      knex.client._query = async (connection, query) => query;
      knex.client.processResponse = () => [];
      knex.client.batchUpdateColumnTypesFromDb = async () => ({
        id: '"pg_catalog"."int4"',
      });
      let error;
      try {
        await knex
          .batchUpdate('users', [{ id: 1, avatar: Buffer.from('a') }], 'id', {
            mode: 'json',
          })
          .transacting(knex);
      } catch (caught) {
        error = caught;
      }
      expect(error.message).to.equal(
        'Invalid batch: users has no column avatar'
      );
    });

    it('rejects a null key', function () {
      expect(() =>
        prepareBatch(
          [
            { id: 1, name: 'a' },
            { id: null, name: 'b' },
          ],
          ['id'],
          'last'
        )
      )
        .to.throw(TypeError)
        .with.property(
          'message',
          'Invalid batch: key id is null in row 1; a key must match one row by equality'
        );
    });

    it('rejects an undefined key', function () {
      expect(() =>
        prepareBatch(
          [{ tenant: 1, id: undefined, name: 'a' }],
          ['tenant', 'id'],
          'last'
        )
      )
        .to.throw(TypeError)
        .with.property(
          'message',
          'Invalid batch: key id is undefined in row 0; a key must match one row by equality'
        );
    });

    it('rejects a key column mixing JS types', function () {
      expect(() =>
        prepareBatch(
          [
            { id: 1, name: 'a' },
            { id: '1', name: 'b' },
          ],
          ['id'],
          'last'
        )
      )
        .to.throw(TypeError)
        .with.property(
          'message',
          'Invalid batch: key id holds both number and string values; pass one type so duplicate keys are found'
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

    it('rejects a type name behind more than one schema', function () {
      expect(() =>
        clients['pg'].batchUpdate('users', rows, 'id', {
          columnTypes: { name: 'db.other.mood' },
        })
      )
        .to.throw(TypeError)
        .with.property(
          'message',
          'Invalid columnTypes.name: "db.other.mood" is not a valid type name'
        );
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
        customWrapIdentifier: (value) => value,
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

    it("reads 'from_db' types under the wrapIdentifier column name", async function () {
      const dialectClient = {
        batchUpdateColumnTypesFromDb: async () => ({
          user_id: '"pg_catalog"."int4"',
          display_name: '"pg_catalog"."text"',
        }),
        customWrapIdentifier: (value) =>
          ({ userId: 'user_id', displayName: 'display_name' }[value]),
      };
      expect(
        await resolveColumnTypesFromDb(dialectClient, null, 'users', [
          'userId',
          'displayName',
        ])
      ).to.eql({
        userId: '"pg_catalog"."int4"',
        displayName: '"pg_catalog"."text"',
      });
    });

    it("throws when 'from_db' finds no type for a column", async function () {
      const dialectClient = {
        batchUpdateColumnTypesFromDb: async () => ({ id: 'integer' }),
        customWrapIdentifier: (value) => value,
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
    it("names a missing column when 'json' reads the catalog for a Buffer key", async function () {
      const knex = knexLib({ client: 'pg' });
      knex.client.batchUpdateColumnTypesFromDb = async () => ({
        id: '"pg_catalog"."bytea"',
      });
      let error;
      try {
        await knex
          .batchUpdate('users', [{ id: Buffer.from('a'), nope: 'x' }], 'id', {
            mode: 'json',
          })
          .transacting(knex);
      } catch (caught) {
        error = caught;
      }
      expect(error.message).to.equal('Invalid batch: users has no column nope');
    });

    it("refuses an unsafe catalog type when 'json' reads it for a Buffer key", async function () {
      const knex = knexLib({ client: 'pg' });
      knex.client.batchUpdateColumnTypesFromDb = async () => ({
        id: '"pg_catalog"."bytea"',
        mood: 'USER-DEFINED',
      });
      let error;
      try {
        await knex
          .batchUpdate('users', [{ id: Buffer.from('a'), mood: 'x' }], 'id', {
            mode: 'json',
          })
          .transacting(knex);
      } catch (caught) {
        error = caught;
      }
      expect(error.message).to.equal(
        `Invalid batch: column mood has type "USER-DEFINED", which is not a valid type name; pass mode 'union' with a columnTypes entry for it`
      );
    });

    it("skips the 'from_db' query when 'json' runs a Buffer key as 'union'", async function () {
      const knex = knexLib({ client: 'mysql' });
      const statements = [];
      knex.client.acquireConnection = async () => ({ __knexUid: 'stub' });
      knex.client.releaseConnection = async () => {};
      knex.client._query = async (connection, query) => {
        statements.push(query.sql);
        return query;
      };
      knex.client.processResponse = () => [];
      knex.client.batchUpdateColumnTypesFromDb = async () => {
        statements.push('from_db');
        return { id: 'varbinary(4)', name: 'text' };
      };
      await knex
        .batchUpdate('users', [{ id: Buffer.from('a'), name: 'x' }], 'id', {
          mode: 'json',
          columnTypes: 'from_db',
        })
        .transacting(knex);
      expect(statements).to.eql([
        'update `users` inner join (select ? as `id`, ? as `name`) as `src` on `users`.`id` = `src`.`id` set `users`.`name` = `src`.`name`',
      ]);
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

    it('dedupes equal Date keys', function () {
      expect(
        prepareBatch(
          [
            { at: new Date(0), v: 'a' },
            { at: new Date(0), v: 'b' },
          ],
          ['at'],
          'last'
        ).rows
      ).to.eql([{ at: new Date(0), v: 'b' }]);
    });

    it('dedupes equal Buffer keys', function () {
      expect(
        prepareBatch(
          [
            { token: Buffer.from('ab'), v: 'a' },
            { token: Buffer.from('ab'), v: 'b' },
          ],
          ['token'],
          'last'
        ).rows
      ).to.eql([{ token: Buffer.from('ab'), v: 'b' }]);
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
    it('throws on a duplicate object key when requested', function () {
      expect(() =>
        prepareBatch(
          [
            { id: { a: 1 }, v: 'a' },
            { id: { a: 1 }, v: 'b' },
          ],
          ['id'],
          'throw'
        )
      ).to.throw(
        `Invalid batch: duplicate key [{"a":1}] (use onDuplicateKey: 'last' to keep the last row instead)`
      );
    });

    it('throws on a duplicate object key holding a bigint when requested', function () {
      expect(() =>
        prepareBatch(
          [
            { id: { a: 1n }, v: 'a' },
            { id: { a: 1n }, v: 'b' },
          ],
          ['id'],
          'throw'
        )
      ).to.throw(
        `Invalid batch: duplicate key [{"a":"1"}] (use onDuplicateKey: 'last' to keep the last row instead)`
      );
    });

    it('keeps non-plain object keys as distinct rows', function () {
      class Money {
        #amount;
        constructor(amount) {
          this.#amount = amount;
        }
      }
      const firstKey = new Money(1);
      const secondKey = new Money(2);
      expect(
        prepareBatch(
          [
            { id: firstKey, v: 'a' },
            { id: secondKey, v: 'b' },
          ],
          ['id'],
          'last'
        ).rows
      ).to.eql([
        { id: firstKey, v: 'a' },
        { id: secondKey, v: 'b' },
      ]);
    });

    it('dedupes object keys whatever their property order', function () {
      expect(
        prepareBatch(
          [
            { id: { a: 1, n: { c: 1, d: 2 } }, v: 'a' },
            { id: { n: { d: 2, c: 1 }, a: 1 }, v: 'b' },
          ],
          ['id'],
          'last'
        ).rows
      ).to.eql([{ id: { n: { d: 2, c: 1 }, a: 1 }, v: 'b' }]);
    });

    it('keeps raw keys as distinct rows', function () {
      const knex = knexLib({ client: 'pg' });
      const firstKey = knex.raw('?', [1]);
      const secondKey = knex.raw('?', [2]);
      expect(
        prepareBatch(
          [
            { id: firstKey, v: 'a' },
            { id: secondKey, v: 'b' },
          ],
          ['id'],
          'last'
        ).rows
      ).to.eql([
        { id: firstKey, v: 'a' },
        { id: secondKey, v: 'b' },
      ]);
    });

    it('throws on a duplicate raw key when requested', function () {
      const knex = knexLib({ client: 'pg' });
      const sharedKey = knex.raw('?', [1]);
      expect(() =>
        prepareBatch(
          [
            { id: sharedKey, v: 'x' },
            { id: sharedKey, v: 'y' },
          ],
          ['id'],
          'throw'
        )
      ).to.throw(
        `Invalid batch: duplicate key ["[Raw]"] (use onDuplicateKey: 'last' to keep the last row instead)`
      );
    });

    it('keeps raw composite keys as distinct rows', function () {
      const knex = knexLib({ client: 'pg' });
      const firstKey = knex.raw('?', [1]);
      const secondKey = knex.raw('?', [2]);
      expect(
        prepareBatch(
          [
            { a: firstKey, b: 1, v: 'x' },
            { a: secondKey, b: 1, v: 'y' },
          ],
          ['a', 'b'],
          'last'
        ).rows
      ).to.eql([
        { a: firstKey, b: 1, v: 'x' },
        { a: secondKey, b: 1, v: 'y' },
      ]);
    });

    it('dedupes a raw composite key used twice', function () {
      const knex = knexLib({ client: 'pg' });
      const sharedKey = knex.raw('?', [1]);
      expect(
        prepareBatch(
          [
            { a: sharedKey, b: 1, v: 'x' },
            { a: sharedKey, b: 1, v: 'y' },
          ],
          ['a', 'b'],
          'last'
        ).rows
      ).to.eql([{ a: sharedKey, b: 1, v: 'y' }]);
    });

    it('throws on a duplicate raw composite key when requested', function () {
      const knex = knexLib({ client: 'pg' });
      const sharedKey = knex.raw('?', [1]);
      expect(() =>
        prepareBatch(
          [
            { a: sharedKey, b: 1, v: 'x' },
            { a: sharedKey, b: 1, v: 'y' },
          ],
          ['a', 'b'],
          'throw'
        )
      ).to.throw(
        `Invalid batch: duplicate key ["[Raw]",1] (use onDuplicateKey: 'last' to keep the last row instead)`
      );
    });

    it('keeps non-plain object composite keys as distinct rows', function () {
      class Money {
        #amount;
        constructor(amount) {
          this.#amount = amount;
        }
      }
      const firstKey = new Money(1);
      const secondKey = new Money(2);
      expect(
        prepareBatch(
          [
            { a: firstKey, b: 1, v: 'x' },
            { a: secondKey, b: 1, v: 'y' },
          ],
          ['a', 'b'],
          'last'
        ).rows
      ).to.eql([
        { a: firstKey, b: 1, v: 'x' },
        { a: secondKey, b: 1, v: 'y' },
      ]);
    });

    it('keeps subquery composite keys as distinct rows', function () {
      const firstKey = function () {
        this.select('id').from('accounts').where('name', 'a');
      };
      const secondKey = function () {
        this.select('id').from('accounts').where('name', 'b');
      };
      expect(
        prepareBatch(
          [
            { a: firstKey, b: 1, v: 'x' },
            { a: secondKey, b: 1, v: 'y' },
          ],
          ['a', 'b'],
          'last'
        ).rows
      ).to.eql([
        { a: firstKey, b: 1, v: 'x' },
        { a: secondKey, b: 1, v: 'y' },
      ]);
    });

    it('dedupes equal Date, Buffer and plain object composite keys', function () {
      expect(
        prepareBatch(
          [
            {
              at: new Date('2026-01-01T00:00:00Z'),
              token: Buffer.from('ab'),
              tag: { a: 1 },
              v: 'x',
            },
            {
              at: new Date('2026-01-01T00:00:00Z'),
              token: Buffer.from('ab'),
              tag: { a: 1 },
              v: 'y',
            },
          ],
          ['at', 'token', 'tag'],
          'last'
        ).rows
      ).to.eql([
        {
          at: new Date('2026-01-01T00:00:00Z'),
          token: Buffer.from('ab'),
          tag: { a: 1 },
          v: 'y',
        },
      ]);
    });

    it('keeps a raw and a plain object composite key apart', function () {
      const knex = knexLib({ client: 'pg' });
      const rawKey = knex.raw('?', [1]);
      expect(
        prepareBatch(
          [
            { a: rawKey, b: 1, v: 'x' },
            { a: {}, b: 1, v: 'y' },
          ],
          ['a', 'b'],
          'last'
        ).rows
      ).to.eql([
        { a: rawKey, b: 1, v: 'x' },
        { a: {}, b: 1, v: 'y' },
      ]);
    });

    it('dedupes equal array keys', function () {
      expect(
        prepareBatch(
          [
            { id: [1, 2], v: 'a' },
            { id: [1, 2], v: 'b' },
          ],
          ['id'],
          'last'
        ).rows
      ).to.eql([{ id: [1, 2], v: 'b' }]);
    });
  });
});
