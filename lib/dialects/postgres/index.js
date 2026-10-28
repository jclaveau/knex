// PostgreSQL
// -------
const extend = require('lodash/extend');
const map = require('lodash/map');
const uniqueId = require('lodash/uniqueId');
const { promisify } = require('util');
const Client = require('../../client');

const Transaction = require('./execution/pg-transaction');
const QueryCompiler = require('./query/pg-querycompiler');
const QueryBuilder = require('./query/pg-querybuilder');
const ColumnCompiler = require('./schema/pg-columncompiler');
const TableCompiler = require('./schema/pg-tablecompiler');
const ViewCompiler = require('./schema/pg-viewcompiler');
const ViewBuilder = require('./schema/pg-viewbuilder');
const SchemaCompiler = require('./schema/pg-compiler');
const { makeEscape } = require('../../util/string');
const { isString } = require('../../util/is');

class Client_PG extends Client {
  constructor(config) {
    super(config);
    if (config.returning) {
      this.defaultReturning = config.returning;
    }

    if (config.searchPath) {
      this.searchPath = config.searchPath;
    }
  }
  transaction() {
    return new Transaction(this, ...arguments);
  }

  queryBuilder() {
    return new QueryBuilder(this);
  }

  queryCompiler(builder, formatter) {
    return new QueryCompiler(this, builder, formatter);
  }

  columnCompiler() {
    return new ColumnCompiler(this, ...arguments);
  }

  schemaCompiler() {
    return new SchemaCompiler(this, ...arguments);
  }

  tableCompiler() {
    return new TableCompiler(this, ...arguments);
  }

  viewCompiler() {
    return new ViewCompiler(this, ...arguments);
  }

  viewBuilder() {
    return new ViewBuilder(this, ...arguments);
  }

  _driver() {
    return require('pg');
  }

  wrapIdentifierImpl(value) {
    if (value === '*') return value;

    let arrayAccessor = '';
    const arrayAccessorMatch = value.match(/(.*?)(\[[0-9]+\])/);

    if (arrayAccessorMatch) {
      value = arrayAccessorMatch[1];
      arrayAccessor = arrayAccessorMatch[2];
    }

    return `"${value.replace(/"/g, '""')}"${arrayAccessor}`;
  }

  _acquireOnlyConnection() {
    const connection = new this.driver.Client(this.connectionSettings);

    connection.on('error', (err) => {
      connection.__knex__disposed = err;
    });

    connection.on('end', (err) => {
      connection.__knex__disposed = err || 'Connection ended unexpectedly';
    });

    return connection.connect().then(() => connection);
  }

  // Get a raw connection, called by the `pool` whenever a new
  // connection needs to be added to the pool.
  acquireRawConnection() {
    const client = this;

    return this._acquireOnlyConnection()
      .then(function (connection) {
        if (!client.version) {
          return client.checkVersion(connection).then(function (version) {
            client.version = version;
            return connection;
          });
        }

        return connection;
      })
      .then(async function setSearchPath(connection) {
        await client.setSchemaSearchPath(connection);
        return connection;
      });
  }

  // Used to explicitly close a connection, called internally by the pool
  // when a connection times out or the pool is shutdown.
  async destroyRawConnection(connection) {
    const end = promisify((cb) => connection.end(cb));
    return end();
  }

  // Wraps a native pg.Pool with the interface knex expects from this.pool.
  wrapNativePool(nativePool) {
    const client = this;
    return {
      acquire() {
        return {
          promise: nativePool.connect().then(async (connection) => {
            connection.__knexUid = uniqueId('__knexUid');
            if (!client.version) {
              try {
                client.version = await client.checkVersion(connection);
              } catch (_e) {
                // version check is best-effort
              }
            }
            return connection;
          }),
        };
      },
      release(connection) {
        if (typeof connection.release === 'function') {
          // pg: release(true) destroys the connection instead of returning to pool
          const shouldDestroy = !!connection.__knex__disposed;
          connection.release(shouldDestroy);
          return true;
        }
        return false;
      },
      destroy() {
        // No-op: knex does not own the native pool
        return Promise.resolve();
      },
    };
  }

  // In PostgreSQL, we need to do a version check to do some feature
  // checking on the database.
  checkVersion(connection) {
    return new Promise((resolve, reject) => {
      connection.query('select version();', (err, resp) => {
        if (err) return reject(err);
        resolve(this._parseVersion(resp.rows[0].version));
      });
    });
  }

  _parseVersion(versionString) {
    return /^PostgreSQL (.*?)( |$)/.exec(versionString)[1];
  }

  // Position the bindings for the query. The escape sequence for question mark
  // is \? (e.g. knex.raw("\\?") since javascript requires '\' to be escaped too...)
  positionBindings(sql) {
    let questionCount = 0;
    return sql.replace(/(\\*)(\?)/g, function (match, escapes) {
      if (escapes.length % 2) {
        return '?';
      } else {
        questionCount++;
        return `$${questionCount}`;
      }
    });
  }

  setSchemaSearchPath(connection, searchPath) {
    let path = searchPath || this.searchPath;

    if (!path) return Promise.resolve(true);

    if (!Array.isArray(path) && !isString(path)) {
      throw new TypeError(
        `knex: Expected searchPath to be Array/String, got: ${typeof path}`
      );
    }

    if (isString(path)) {
      if (path.includes(',')) {
        const parts = path.split(',');
        const arraySyntax = `[${parts
          .map((searchPath) => `'${searchPath}'`)
          .join(', ')}]`;
        this.logger.warn(
          `Detected comma in searchPath "${path}".` +
            `If you are trying to specify multiple schemas, use Array syntax: ${arraySyntax}`
        );
      }
      path = [path];
    }

    path = path
      .map((schemaName) => `"${schemaName.replace(/"/g, '""')}"`)
      .join(',');

    return new Promise(function (resolver, rejecter) {
      connection.query(`set search_path to ${path}`, function (err) {
        if (err) return rejecter(err);
        resolver(true);
      });
    });
  }

  _stream(connection, obj, stream, options) {
    if (!obj.sql) throw new Error('The query is empty');

    let PGQueryStream;
    if (process.browser) {
      PGQueryStream = undefined;
    } else {
      try {
        PGQueryStream = require('pg-query-stream');
      } catch (e) {
        if (
          e instanceof Error &&
          e.code === 'MODULE_NOT_FOUND' &&
          e.message.includes('pg-query-stream')
        ) {
          throw new Error(
            "knex PostgreSQL query streaming requires the 'pg-query-stream' package. Please install it (e.g. `npm i pg-query-stream`)."
          );
        }
        throw e;
      }
    }
    const sql = obj.sql;

    return new Promise(function (resolver, rejecter) {
      const queryStream = connection.query(
        new PGQueryStream(sql, obj.bindings, options)
      );

      queryStream.on('error', function (error) {
        rejecter(error);
        stream.emit('error', error);
      });

      queryStream.on('end', resolver);
      queryStream.pipe(stream);
    });
  }

  // Runs the query on the specified connection, providing the bindings
  // and any other necessary prep work.
  _query(connection, obj) {
    if (!obj.sql) throw new Error('The query is empty');

    let queryConfig = {
      text: obj.sql,
      values: obj.bindings || [],
    };

    if (obj.options) {
      queryConfig = extend(queryConfig, obj.options);
    }

    return new Promise(function (resolver, rejecter) {
      connection.query(queryConfig, function (err, response) {
        if (err) return rejecter(err);
        obj.response = response;
        resolver(obj);
      });
    });
  }

  // Ensures the response is returned in the same format as other clients.
  processResponse(obj, runner) {
    const resp = obj.response;
    if (obj.output) return obj.output.call(runner, resp);
    if (obj.method === 'raw') return resp;
    const { returning } = obj;
    if (resp.command === 'SELECT') {
      if (obj.method === 'first') return resp.rows[0];
      if (obj.method === 'pluck') return map(resp.rows, obj.pluck);
      return resp.rows;
    }
    if (returning) {
      const returns = [];
      for (let i = 0, l = resp.rows.length; i < l; i++) {
        const row = resp.rows[i];
        returns[i] = row;
      }
      return returns;
    }
    if (resp.command === 'UPDATE' || resp.command === 'DELETE') {
      return resp.rowCount;
    }
    return resp;
  }

  async cancelQuery(connectionToKill) {
    const conn = await this.acquireRawConnection();

    try {
      return await this._wrappedCancelQueryCall(conn, connectionToKill);
    } finally {
      await this.destroyRawConnection(conn).catch((err) => {
        this.logger.warn(`Connection Error: ${err}`);
      });
    }
  }
  _wrappedCancelQueryCall(conn, connectionToKill) {
    return this._query(conn, {
      sql: 'SELECT pg_cancel_backend($1);',
      bindings: [connectionToKill.processID],
      options: {},
    });
  }

  toPathForJson(jsonPath) {
    const PG_PATH_REGEX = /^{.*}$/;
    if (jsonPath.match(PG_PATH_REGEX)) {
      return jsonPath;
    }
    return (
      '{' +
      jsonPath
        .replace(/^(\$\.)/, '') // remove the first dollar
        .replace('.', ',')
        .replace(/\[([0-9]+)]/, ',$1') + // transform [number] to ,number
      '}'
    );
  }

  // 'json' mode expands the chunk with jsonb_populate_recordset against the
  // table's row type (CockroachDB inherits this), so columnTypes has no role.
  batchUpdateJsonTakesColumnTypes() {
    return false;
  }

  // In case mode each updated row walks every column's CASE list, so a
  // statement costs about rows × columns × chunk; the fastest chunk holds about
  // CASE_BRANCH_BUDGET branches (rows × columns). A composite key's WHERE is an
  // OR chain, one index scan per row, whose planning time grows faster than the
  // chain (2.5 ms at 50 rows, 680 ms at 1000), so its chunk stops at
  // COMPOSITE_CASE_ROWS. Measured on PostgreSQL and CockroachDB (which inherits
  // this) in scripts/batch-update-benchmark.md#postgresql-case-chunk-size.
  batchUpdateRowLimit(mode, keyCount, columnCount) {
    if (mode !== 'case') {
      return Infinity;
    }
    const budgetRows = Math.floor(CASE_BRANCH_BUDGET / columnCount);
    const keyRows = keyCount > 1 ? COMPOSITE_CASE_ROWS : Infinity;
    return Math.max(1, Math.min(budgetRows, keyRows));
  }

  // Castable type names from the catalog (CockroachDB inherits this), each as
  // its quoted schema-qualified name plus `[]` for an array (`"pg_catalog"."varchar"`,
  // `"public"."mood"[]`), keyed by the column's name in the table, since
  // columnInfo only says `USER-DEFINED` or `ARRAY`.
  // The name carries no length or precision: an explicit cast to
  // `varchar(5)` truncates silently where .update()'s assignment raises, and
  // the column's own modifier still applies on assignment. format_type isn't
  // used because it spells a bare bpchar and bit `character` and `bit`, which
  // a cast reads as length 1. An unqualified table resolves through the
  // search_path, like the UPDATE itself.
  async batchUpdateColumnTypesFromDb(tr, tableName) {
    // Split on dots and wrap each part as knex wraps an identifier, so
    // `schema.table` (or `database.schema.table`) names the relation the
    // UPDATE targets.
    const nameParts = tableName
      .split('.')
      .map((part) => this.customWrapIdentifier(part, (identity) => identity));
    const relation = tr.raw(
      nameParts.map(() => 'quote_ident(?)').join(` || '.' || `),
      nameParts
    );
    // An array type is its element's typarray: int2vector and a domain over
    // an array also sit in category 'A', and cast under their own name.
    // Aliases carry no underscore, which a postProcessResponse may rewrite.
    const { rows } = await tr.raw(
      `select a.attname as columnname,
        en.nspname as typeschema, et.typname as typename,
        elem.oid is not null as isarray
      from pg_attribute a
      join pg_type t on t.oid = a.atttypid
      left join pg_type elem
        on elem.oid = t.typelem and elem.typarray = t.oid
      join pg_type et on et.oid = coalesce(elem.oid, t.oid)
      join pg_namespace en on en.oid = et.typnamespace
      where a.attrelid = (?)::regclass and a.attnum > 0 and not a.attisdropped`,
      [relation]
    );
    const types = {};
    for (const row of rows) {
      types[row.columnname] = `"${row.typeschema}"."${row.typename}"${
        row.isarray ? '[]' : ''
      }`;
    }
    return types;
  }
}

Object.assign(Client_PG.prototype, {
  dialect: 'postgresql',

  driverName: 'pg',
  // Postgres wire protocol counts bound parameters in an int16 (Redshift and
  // CockroachDB inherit this); batchUpdate caps chunks to stay under it.
  maxBindParameters: 65535,
  canCancelQuery: true,

  _escapeBinding: makeEscape({
    escapeArray(val, esc) {
      return esc(arrayString(val, esc));
    },
    escapeString(str) {
      let hasBackslash = false;
      let escaped = "'";
      for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (c === "'") {
          escaped += c + c;
        } else if (c === '\\') {
          escaped += c + c;
          hasBackslash = true;
        } else {
          escaped += c;
        }
      }
      escaped += "'";
      if (hasBackslash === true) {
        escaped = 'E' + escaped;
      }
      return escaped;
    },
    escapeObject(val, prepareValue, timezone, seen = []) {
      if (val && typeof val.toPostgres === 'function') {
        seen = seen || [];
        if (seen.indexOf(val) !== -1) {
          throw new Error(
            `circular reference detected while preparing "${val}" for query`
          );
        }
        seen.push(val);
        return prepareValue(val.toPostgres(prepareValue), seen);
      }
      return JSON.stringify(val);
    },
  }),
});

function arrayString(arr, esc) {
  let result = '{';
  for (let i = 0; i < arr.length; i++) {
    if (i > 0) result += ',';
    const val = arr[i];
    if (val === null || typeof val === 'undefined') {
      result += 'NULL';
    } else if (Array.isArray(val)) {
      result += arrayString(val, esc);
    } else if (typeof val === 'number') {
      result += val;
    } else {
      result += JSON.stringify(typeof val === 'string' ? val : esc(val));
    }
  }
  return result + '}';
}

const CASE_BRANCH_BUDGET = 1000;
const COMPOSITE_CASE_ROWS = 50;

module.exports = Client_PG;
