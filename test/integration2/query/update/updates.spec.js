'use strict';

const { expect } = require('chai');
const crypto = require('crypto');

const { TEST_TIMESTAMP } = require('../../../util/constants');
const {
  isPostgreSQL,
  isMysql,
  isMariaDB,
  isMssql,
  isOracle,
  isCockroachDB,
  isSQLite,
} = require('../../../util/db-helpers');
const {
  getAllDbs,
  getKnexForDb,
} = require('../../util/knex-instance-provider');
const logger = require('../../../integration/logger');
const {
  dropTables,
  createAccounts,
} = require('../../../util/tableCreatorHelper');
const { insertAccounts } = require('../../../util/dataInsertHelper');
const { assertNumber } = require('../../../util/assertHelper');

let TEST_USER_ROW;

describe('Updates', function () {
  getAllDbs().forEach((db) => {
    describe(db, () => {
      let knex;
      let accountId1;

      before(async () => {
        knex = logger(getKnexForDb(db));
        await dropTables(knex);
        await createAccounts(knex);
      });

      after(async () => {
        await dropTables(knex);
        return knex.destroy();
      });

      beforeEach(async () => {
        await knex('accounts').truncate();
        await insertAccounts(knex);
        const accounts = await knex('accounts').select().where({
          email: 'test1@example.com',
        });
        TEST_USER_ROW = {
          ...accounts[0],
          created_at: TEST_TIMESTAMP,
          updated_at: TEST_TIMESTAMP,
        };
        accountId1 = TEST_USER_ROW.id;
      });

      it('should handle updates', async function () {
        await knex('accounts')
          .where('id', 1)
          .update({
            first_name: 'User',
            last_name: 'Test',
            email: 'test100@example.com',
          })
          .testSql(function (tester) {
            tester(
              'mysql',
              'update `accounts` set `first_name` = ?, `last_name` = ?, `email` = ? where `id` = ?',
              ['User', 'Test', 'test100@example.com', 1],
              1
            );
            tester(
              'pg',
              'update "accounts" set "first_name" = ?, "last_name" = ?, "email" = ? where "id" = ?',
              ['User', 'Test', 'test100@example.com', 1],
              1
            );
            tester(
              'pg-redshift',
              'update "accounts" set "first_name" = ?, "last_name" = ?, "email" = ? where "id" = ?',
              ['User', 'Test', 'test100@example.com', 1],
              1
            );
            tester(
              'sqlite3',
              'update `accounts` set `first_name` = ?, `last_name` = ?, `email` = ? where `id` = ?',
              ['User', 'Test', 'test100@example.com', 1],
              1
            );
            tester(
              'mssql',
              'update [accounts] set [first_name] = ?, [last_name] = ?, [email] = ? where [id] = ?;select @@rowcount',
              ['User', 'Test', 'test100@example.com', 1],
              1
            );
          });
      });

      it('#5738 should handle update with comments', async function () {
        await knex('accounts')
          .where('id', 1)
          .update({
            first_name: 'User',
            last_name: 'Test',
            email: 'test100@example.com',
          })
          .comment('update in account')
          .testSql(function (tester) {
            tester(
              'mysql',
              '/* update in account */ update `accounts` set `first_name` = ?, `last_name` = ?, `email` = ? where `id` = ?',
              ['User', 'Test', 'test100@example.com', 1],
              1
            );
          });
      });

      it('should allow for null updates', async function () {
        await knex('accounts')
          .where('id', 1000)
          .update({
            email: 'test100@example.com',
            first_name: null,
            last_name: 'Test',
          })
          .testSql(function (tester) {
            tester(
              'mysql',
              'update `accounts` set `email` = ?, `first_name` = ?, `last_name` = ? where `id` = ?',
              ['test100@example.com', null, 'Test', 1000],
              0
            );
            tester(
              'mssql',
              'update [accounts] set [email] = ?, [first_name] = ?, [last_name] = ? where [id] = ?;select @@rowcount',
              ['test100@example.com', null, 'Test', 1000],
              0
            );
          });
      });

      it('should immediately return updated value for other connections when updating row to DB returns', async function () {
        const res = await knex('accounts');

        async function runTest() {
          return Promise.all(
            res.map(async (origRow) => {
              await knex.transaction(
                async (trx) =>
                  await trx('accounts')
                    .where('id', origRow.id)
                    .update({ balance: 654 })
              );

              const updatedRow = await knex('accounts').where('id', origRow.id);

              expect(updatedRow[0].balance).to.equal(654);

              await knex.transaction(
                async (trx) =>
                  await trx('accounts')
                    .where('id', origRow.id)
                    .update({ balance: origRow.balance })
              );

              const updatedRow2 = await knex('accounts').where(
                'id',
                origRow.id
              );

              expect(updatedRow2[0].balance).to.equal(origRow.balance);
            })
          );
        }

        // run few times to try to catch the problem
        for (let i = 0; i <= 20; i++) {
          await runTest();
        }
      });

      it('should increment a value', async function () {
        const accounts = await knex('accounts')
          .select('logins')
          .where('id', accountId1);
        const rowsAffected = await knex('accounts')
          .where('id', accountId1)
          .increment('logins');
        expect(rowsAffected).to.equal(1);
        const accounts2 = await knex('accounts')
          .select('logins')
          .where('id', accountId1);
        assertNumber(
          knex,
          accounts2[0].logins,
          parseInt(accounts[0].logins) + 1
        );
      });

      it('should increment a negative value', async function () {
        const accounts = await knex('accounts')
          .select('logins')
          .where('id', accountId1);
        const rowsAffected = await knex('accounts')
          .where('id', accountId1)
          .increment('logins', -2);
        expect(rowsAffected).to.equal(1);
        const accounts2 = await knex('accounts')
          .select('logins')
          .where('id', accountId1);
        assertNumber(knex, accounts2[0].logins, accounts[0].logins - 2);
      });

      it('should increment a float value', async function () {
        const accounts = await knex('accounts')
          .select('balance')
          .where('id', accountId1);
        const rowsAffected = await knex('accounts')
          .where('id', accountId1)
          .increment('balance', 22.53);
        expect(rowsAffected).to.equal(1);
        const accounts2 = await knex('accounts')
          .select('balance')
          .where('id', accountId1);
        expect(accounts[0].balance + 22.53).to.be.closeTo(
          accounts2[0].balance,
          0.001
        );
      });

      it('should decrement a value', async function () {
        const accounts = await knex('accounts')
          .select('logins')
          .where('id', accountId1);
        const rowsAffected = await knex('accounts')
          .where('id', accountId1)
          .decrement('logins');
        expect(rowsAffected).to.equal(1);
        const accounts2 = await knex('accounts')
          .select('logins')
          .where('id', accountId1);
        assertNumber(knex, accounts2[0].logins, accounts[0].logins - 1);
      });

      it('should decrement a negative value', async function () {
        const accounts = await knex('accounts')
          .select('logins')
          .where('id', accountId1);
        const rowsAffected = await knex('accounts')
          .where('id', accountId1)
          .decrement('logins', -2);
        expect(rowsAffected).to.equal(1);
        const accounts2 = await knex('accounts')
          .select('logins')
          .where('id', accountId1);
        assertNumber(
          knex,
          accounts2[0].logins,
          parseInt(accounts[0].logins) + 2
        );
      });

      it('should decrement a float value', async function () {
        const accounts = await knex('accounts')
          .select('balance')
          .where('id', accountId1);

        const rowsAffected = await knex('accounts')
          .where('id', accountId1)
          .decrement('balance', 10.29);
        expect(rowsAffected).to.equal(1);
        const accounts2 = await knex('accounts')
          .select('balance')
          .where('id', accountId1);
        expect(accounts[0].balance - 10.29).to.be.closeTo(
          accounts2[0].balance,
          0.001
        );
      });

      it('should allow query builder as update value', async function () {
        // mysql does not support this subquery syntax
        if (isMysql(knex) || isOracle(knex)) {
          return this.skip();
        }
        await knex('accounts')
          .where('id', accountId1)
          .update(
            'balance',
            knex('accounts').select('balance').where('id', accountId1)
          )
          .testSql(function (tester) {
            tester(
              'mysql',
              'update `accounts` set `balance` = (select `balance` from `accounts` where `id` = ?) where `id` = ?',
              [accountId1, accountId1],
              1
            );
            tester(
              'pg',
              'update "accounts" set "balance" = (select "balance" from "accounts" where "id" = ?) where "id" = ?',
              [accountId1, accountId1],
              1
            );
            tester(
              'cockroachdb',
              'update "accounts" set "balance" = (select "balance" from "accounts" where "id" = ?) where "id" = ?',
              [accountId1, accountId1],
              1
            );
            tester(
              'pg-redshift',
              'update "accounts" set "email" = ?, "first_name" = ?, "last_name" = ? where "id" = ?',
              [accountId1, accountId1],
              1
            );
            tester(
              'sqlite3',
              'update `accounts` set `balance` = (select `balance` from `accounts` where `id` = ?) where `id` = ?',
              [accountId1, accountId1],
              1
            );
            tester(
              'mssql',
              'update [accounts] set [balance] = (select [balance] from [accounts] where [id] = ?) where [id] = ?;select @@rowcount',
              [accountId1, accountId1],
              1
            );
          });
      });

      it('should allow query builder with returning as update value', async function () {
        // mysql / cockroach do not not support this subquery syntax
        if (isMysql(knex) || isOracle(knex)) {
          return this.skip();
        }
        await knex('accounts')
          .where('id', accountId1)
          .update(
            'balance',
            knex('accounts').select('balance').where('id', accountId1),
            '*'
          )
          .testSql(function (tester) {
            tester(
              'mysql',
              'update `accounts` set `balance` = (select `balance` from `accounts` where `id` = ?) where `id` = ? returning *',
              [accountId1, accountId1],
              1
            );
            tester(
              'pg',
              'update "accounts" set "balance" = (select "balance" from "accounts" where "id" = ?) where "id" = ? returning *',
              [accountId1, accountId1],
              [TEST_USER_ROW]
            );
            tester(
              'cockroachdb',
              'update "accounts" set "balance" = (select "balance" from "accounts" where "id" = ?) where "id" = ? returning *',
              [accountId1, accountId1],
              [TEST_USER_ROW]
            );
            tester(
              'pg-redshift',
              'update "accounts" set "email" = ?, "first_name" = ?, "last_name" = ? where "id" = ? returning *',
              [accountId1, accountId1],
              [TEST_USER_ROW]
            );
            tester(
              'sqlite3',
              'update `accounts` set `balance` = (select `balance` from `accounts` where `id` = ?) where `id` = ? returning *',
              [accountId1, accountId1],
              [TEST_USER_ROW]
            );
            tester(
              'mssql',
              'update [accounts] set [balance] = (select [balance] from [accounts] where [id] = ?) output inserted.* where [id] = ?',
              [accountId1, accountId1],
              [TEST_USER_ROW]
            );
          });
      });

      it('should allow returning for updates', async function () {
        await knex('accounts').where('id', accountId1).update({
          balance: 12.240000000000002,
        });

        await knex('accounts')
          .where('id', accountId1)
          .update(
            {
              email: 'test100@example.com',
              first_name: 'UpdatedUser',
              last_name: 'UpdatedTest',
            },
            '*'
          )
          .testSql(function (tester) {
            tester(
              'mysql',
              'update `accounts` set `email` = ?, `first_name` = ?, `last_name` = ? where `id` = ?',
              ['test100@example.com', 'UpdatedUser', 'UpdatedTest', 1],
              1
            );
            tester(
              'pg',
              'update "accounts" set "email" = ?, "first_name" = ?, "last_name" = ? where "id" = ? returning *',
              ['test100@example.com', 'UpdatedUser', 'UpdatedTest', '1'],
              [
                {
                  ...TEST_USER_ROW,
                  balance: 12.24,
                  first_name: 'UpdatedUser',
                  last_name: 'UpdatedTest',
                  email: 'test100@example.com',
                },
              ]
            );
            tester(
              'cockroachdb',
              'update "accounts" set "email" = ?, "first_name" = ?, "last_name" = ? where "id" = ? returning *',
              ['test100@example.com', 'UpdatedUser', 'UpdatedTest', accountId1],
              [
                {
                  ...TEST_USER_ROW,
                  first_name: 'UpdatedUser',
                  last_name: 'UpdatedTest',
                  email: 'test100@example.com',
                  balance: 12.24,
                },
              ]
            );
            tester(
              'pg-redshift',
              'update "accounts" set "email" = ?, "first_name" = ?, "last_name" = ? where "id" = ?',
              ['test100@example.com', 'UpdatedUser', 'UpdatedTest', 1],
              1
            );
            tester(
              'sqlite3',
              'update `accounts` set `email` = ?, `first_name` = ?, `last_name` = ? where `id` = ? returning *',
              ['test100@example.com', 'UpdatedUser', 'UpdatedTest', 1],
              [
                {
                  ...TEST_USER_ROW,
                  first_name: 'UpdatedUser',
                  last_name: 'UpdatedTest',
                  email: 'test100@example.com',
                  balance: 12.240000000000002,
                },
              ]
            );
            tester(
              'oracledb',
              'update "accounts" set "email" = ?, "first_name" = ?, "last_name" = ? where "id" = ? returning "ROWID" into ?',
              [
                'test100@example.com',
                'UpdatedUser',
                'UpdatedTest',
                1,
                (v) => v.toString() === '[object ReturningHelper:ROWID]',
              ],
              [
                {
                  ...TEST_USER_ROW,
                  first_name: 'UpdatedUser',
                  last_name: 'UpdatedTest',
                  email: 'test100@example.com',
                  balance: 12.24,
                },
              ]
            );
            tester(
              'mssql',
              'update [accounts] set [email] = ?, [first_name] = ?, [last_name] = ? output inserted.* where [id] = ?',
              ['test100@example.com', 'UpdatedUser', 'UpdatedTest', '1'],
              [
                {
                  ...TEST_USER_ROW,
                  first_name: 'UpdatedUser',
                  last_name: 'UpdatedTest',
                  email: 'test100@example.com',
                  balance: 12.240000000000002,
                },
              ]
            );
          });
      });

      it('should allow returning for updates with specific transaction', async function () {
        await knex('accounts').where('id', accountId1).update({
          balance: 12.240000000000002,
        });

        await knex.transaction(function (tr) {
          return knex('accounts')
            .transacting(tr)
            .where('id', accountId1)
            .update(
              {
                email: 'test100@example.com',
                first_name: 'UpdatedUser',
                last_name: 'UpdatedTest',
              },
              '*'
            )
            .testSql(function (tester) {
              tester(
                'mysql',
                'update `accounts` set `email` = ?, `first_name` = ?, `last_name` = ? where `id` = ?',
                ['test100@example.com', 'UpdatedUser', 'UpdatedTest', 1],
                1
              );
              tester(
                'pg',
                'update "accounts" set "email" = ?, "first_name" = ?, "last_name" = ? where "id" = ? returning *',
                ['test100@example.com', 'UpdatedUser', 'UpdatedTest', '1'],
                [
                  {
                    id: '1',
                    first_name: 'UpdatedUser',
                    last_name: 'UpdatedTest',
                    email: 'test100@example.com',
                    logins: 1,
                    balance: 12.24,
                    about: 'Lorem ipsum Dolore labore incididunt enim.',
                    created_at: TEST_TIMESTAMP,
                    updated_at: TEST_TIMESTAMP,
                    phone: null,
                  },
                ]
              );
              tester(
                'cockroachdb',
                'update "accounts" set "email" = ?, "first_name" = ?, "last_name" = ? where "id" = ? returning *',
                [
                  'test100@example.com',
                  'UpdatedUser',
                  'UpdatedTest',
                  accountId1,
                ],
                [
                  {
                    id: accountId1,
                    first_name: 'UpdatedUser',
                    last_name: 'UpdatedTest',
                    email: 'test100@example.com',
                    logins: '1',
                    balance: 12.24,
                    about: 'Lorem ipsum Dolore labore incididunt enim.',
                    created_at: TEST_TIMESTAMP,
                    updated_at: TEST_TIMESTAMP,
                    phone: null,
                  },
                ]
              );
              tester(
                'pg-redshift',
                'update "accounts" set "email" = ?, "first_name" = ?, "last_name" = ? where "id" = ?',
                ['test100@example.com', 'UpdatedUser', 'UpdatedTest', 1],
                1
              );
              tester(
                'sqlite3',
                'update `accounts` set `email` = ?, `first_name` = ?, `last_name` = ? where `id` = ? returning *',
                ['test100@example.com', 'UpdatedUser', 'UpdatedTest', 1],
                [
                  {
                    id: 1,
                    first_name: 'UpdatedUser',
                    last_name: 'UpdatedTest',
                    email: 'test100@example.com',
                    logins: 1,
                    balance: 12.240000000000002,
                    about: 'Lorem ipsum Dolore labore incididunt enim.',
                    created_at: TEST_TIMESTAMP,
                    updated_at: TEST_TIMESTAMP,
                    phone: null,
                  },
                ]
              );
              tester(
                'oracledb',
                'update "accounts" set "email" = ?, "first_name" = ?, "last_name" = ? where "id" = ? returning "ROWID" into ?',
                [
                  'test100@example.com',
                  'UpdatedUser',
                  'UpdatedTest',
                  1,
                  (v) => v.toString() === '[object ReturningHelper:ROWID]',
                ],
                [
                  {
                    id: accountId1,
                    first_name: 'UpdatedUser',
                    last_name: 'UpdatedTest',
                    email: 'test100@example.com',
                    logins: 1,
                    balance: 12.24,
                    about: 'Lorem ipsum Dolore labore incididunt enim.',
                    created_at: TEST_TIMESTAMP,
                    updated_at: TEST_TIMESTAMP,
                    phone: null,
                  },
                ]
              );
              tester(
                'mssql',
                'update [accounts] set [email] = ?, [first_name] = ?, [last_name] = ? output inserted.* where [id] = ?',
                ['test100@example.com', 'UpdatedUser', 'UpdatedTest', '1'],
                [
                  {
                    id: '1',
                    first_name: 'UpdatedUser',
                    last_name: 'UpdatedTest',
                    email: 'test100@example.com',
                    logins: 1,
                    balance: 12.240000000000002,
                    about: 'Lorem ipsum Dolore labore incididunt enim.',
                    created_at: TEST_TIMESTAMP,
                    updated_at: TEST_TIMESTAMP,
                    phone: null,
                  },
                ]
              );
            });
        });
      });

      it('with update query', async function () {
        if (isMariaDB(knex)) {
          // MariaDB does not support CTEs (WITH) in UPDATE statements.
          return this.skip();
        }
        await knex
          .with('withClause', function () {
            this.select('last_name')
              .from('accounts')
              .where('email', '=', 'test1@example.com');
          })
          .update({ last_name: 'olivier' })
          .where('last_name', '=', 'User')
          .from('accounts');
        const results = await knex('accounts')
          .from('accounts')
          .where('email', '=', 'test1@example.com');
        expect(results[0].last_name).to.equal('olivier');
      });

      it('should allow explicit from', async function () {
        if (!isPostgreSQL(knex)) {
          return this.skip();
        }

        await knex('accounts')
          .update({ last_name: 'olivier' })
          .with('withClause', function () {
            this.select('id', 'last_name')
              .from('accounts')
              .where('email', '=', 'test1@example.com');
          })
          .updateFrom('withClause')
          .where('withClause.id', '=', knex.ref('accounts.id'))
          .testSql(function (tester) {
            tester(
              'pg',
              'with "withClause" as (select "id", "last_name" from "accounts" where "email" = ?) update "accounts" set "last_name" = ? from "withClause" where "withClause"."id" = "accounts"."id"',
              ['test1@example.com', 'olivier'],
              1
            );
          });
      });

      it('should escaped json objects when update value #5059', async function () {
        await knex.schema.dropTableIfExists('testing');
        await knex.schema.createTable('testing', (t) => {
          t.increments('id');
          t.string('one');
          t.integer('two');
        });
        await knex('testing')
          .update('one', { one: 123, two: 456 })
          .where('id', 1)
          .testSql(function (tester) {
            tester('mysql', 'update `testing` set `one` = ? where `id` = ?', [
              '{"one":123,"two":456}',
              1,
            ]);
            tester('pg', 'update "testing" set "one" = ? where "id" = ?', [
              '{"one":123,"two":456}',
              1,
            ]);
            tester(
              'pg-redshift',
              'update "testing" set "one" = ? where "id" = ?',
              ['{"one":123,"two":456}', 1]
            );
            tester('sqlite3', 'update `testing` set `one` = ? where `id` = ?', [
              '{"one":123,"two":456}',
              1,
            ]);
            tester('mysql', 'update `testing` set `one` = ? where `id` = ?', [
              '{"one":123,"two":456}',
              1,
            ]);
            tester(
              'mssql',
              'update [testing] set [one] = ? where [id] = ?;select @@rowcount',
              ['{"one":123,"two":456}', 1]
            );
          });
        await knex.schema.dropTable('testing');
      });

      it('handle from bindings in the right order #6376', async function () {
        if (!isPostgreSQL(knex)) {
          return this.skip();
        }

        await knex('accounts')
          .update({ last_name: knex.ref('values.last_name') })
          .updateFrom(
            knex.raw('(VALUES (?, ?), (?, ?)) as ?? (??, ??)', [
              'test1@example.com',
              'John',
              'test2@example.com',
              'Jane',
              'values',
              'email',
              'last_name',
            ])
          )
          .where(knex.raw('?', [1]), '=', 1)
          .andWhere('accounts.email', knex.ref('values.email'))
          .testSql(function (tester) {
            tester(
              'pg',
              'update "accounts" set "last_name" = "values"."last_name" from (VALUES (?, ?), (?, ?)) as "values" ("email", "last_name") where ? = ? and "accounts"."email" = "values"."email"',
              ['test1@example.com', 'John', 'test2@example.com', 'Jane', 1, 1],
              2
            );
          });
      });

      describe('batchUpdate', function () {
        beforeEach(async () => {
          await knex.schema.dropTableIfExists('members');
          await knex.schema.createTable('members', (table) => {
            table.integer('id').primary();
            table.string('name');
            table.integer('age');
          });
          await knex('members').insert([
            { id: 1, name: 'old1', age: 1 },
            { id: 2, name: 'old2', age: 2 },
            { id: 3, name: 'decoy', age: 99 },
          ]);
        });

        after(async () => {
          await knex.schema.dropTableIfExists('members');
        });

        it('updates each row to its own values and leaves other rows untouched', async function () {
          await knex.batchUpdate('members', [
            { id: 1, name: 'new1', age: 11 },
            { id: 2, name: 'new2', age: 22 },
          ]);

          const rows = await knex('members').orderBy('id');
          // Number() coerces CockroachDB's int-as-string columns.
          expect(rows.map((r) => [Number(r.id), r.name, Number(r.age)])).to.eql(
            [
              [1, 'new1', 11],
              [2, 'new2', 22],
              [3, 'decoy', 99], // outside the batch — must be unchanged
            ]
          );
        });

        it("updates each row to its own values with mode: 'case'", async function () {
          await knex.batchUpdate(
            'members',
            [
              { id: 1, name: 'new1', age: 11 },
              { id: 2, name: 'new2', age: 22 },
            ],
            'id',
            { mode: 'case' }
          );

          const rows = await knex('members').orderBy('id');
          expect(rows.map((r) => [Number(r.id), r.name, Number(r.age)])).to.eql(
            [
              [1, 'new1', 11],
              [2, 'new2', 22],
              [3, 'decoy', 99], // outside the batch — must be unchanged
            ]
          );
        });

        it("updates each row to its own values with mode: 'json'", async function () {
          // Postgres/CockroachDB (jsonb_to_recordset) infer types and SQLite is
          // typeless; the JSON_TABLE/OPENJSON dialects need an explicit map.
          const options = { mode: 'json' };
          if (isMysql(knex)) {
            options.columnTypes = {
              id: 'int',
              name: 'char(255)',
              age: 'int',
            };
          } else if (isMssql(knex)) {
            options.columnTypes = {
              id: 'int',
              name: 'nvarchar(255)',
              age: 'int',
            };
          } else if (isOracle(knex)) {
            options.columnTypes = {
              id: 'number',
              name: 'varchar2(255)',
              age: 'number',
            };
          }
          await knex.batchUpdate(
            'members',
            [
              { id: 1, name: 'new1', age: 11 },
              { id: 2, name: 'new2', age: 22 },
            ],
            'id',
            options
          );

          const rows = await knex('members').orderBy('id');
          expect(rows.map((r) => [Number(r.id), r.name, Number(r.age)])).to.eql(
            [
              [1, 'new1', 11],
              [2, 'new2', 22],
              [3, 'decoy', 99], // outside the batch — must be unchanged
            ]
          );
        });

        it("resolves columnTypes from the schema with 'from_db'", async function () {
          // from_db reads types via columnInfo; exercised on the json path,
          // which consumes columnTypes on postgres/sqlite.
          if (!(isPostgreSQL(knex) || isSQLite(knex))) {
            return this.skip();
          }
          await knex.batchUpdate(
            'members',
            [
              { id: 1, name: 'fromdb1', age: 11 },
              { id: 2, name: 'fromdb2', age: 22 },
            ],
            'id',
            { mode: 'json', columnTypes: 'from_db' }
          );

          const rows = await knex('members').orderBy('id');
          expect(rows.map((r) => [Number(r.id), r.name, Number(r.age)])).to.eql(
            [
              [1, 'fromdb1', 11],
              [2, 'fromdb2', 22],
              [3, 'decoy', 99],
            ]
          );
        });

        it('returns the requested columns on postgres-family dialects', async function () {
          if (!(isPostgreSQL(knex) || isCockroachDB(knex))) {
            return this.skip();
          }
          const result = await knex
            .batchUpdate('members', [{ id: 1, name: 'ret', age: 5 }])
            .returning(['id', 'name']);
          expect(result.length).to.equal(1);
          expect(result[0].name).to.equal('ret');
          // CockroachDB returns INT columns as strings
          assertNumber(knex, result[0].id, 1);
        });

        it('updates across multiple chunks', async function () {
          await knex.batchUpdate(
            'members',
            [
              { id: 1, name: 'c1', age: 100 },
              { id: 2, name: 'c2', age: 200 },
            ],
            'id',
            1 // one row per chunk -> two statements in one transaction
          );
          const rows = await knex('members')
            .whereIn('id', [1, 2])
            .orderBy('id');
          expect(rows.map((r) => r.name)).to.eql(['c1', 'c2']);
        });

        it('runs ceil(rows / chunkSize) set-based statements', async function () {
          const statements = [];
          const onQuery = (query) => {
            // count the data statements only, not BEGIN/COMMIT
            if (/^\s*(update|merge)\s/i.test(query.sql)) {
              statements.push(query.sql);
            }
          };
          const threeRows = [
            { id: 1, name: 's1', age: 1 },
            { id: 2, name: 's2', age: 2 },
            { id: 3, name: 's3', age: 3 },
          ];

          // 3 rows, chunkSize 2 -> ceil(3/2) = 2 statements
          knex.on('query', onQuery);
          await knex.batchUpdate('members', threeRows, 'id', { chunkSize: 2 });
          knex.off('query', onQuery);
          expect(statements).to.have.lengthOf(2);

          // 3 rows, single (default) chunk -> 1 statement
          statements.length = 0;
          knex.on('query', onQuery);
          await knex.batchUpdate('members', threeRows, 'id');
          knex.off('query', onQuery);
          expect(statements).to.have.lengthOf(1);
        });

        it('supports a composite key', async function () {
          await knex.schema.dropTableIfExists('memberships');
          await knex.schema.createTable('memberships', (table) => {
            table.integer('tenant');
            table.integer('id');
            table.string('name');
            table.primary(['tenant', 'id']);
          });
          await knex('memberships').insert([
            { tenant: 7, id: 1, name: 'a' },
            { tenant: 7, id: 2, name: 'b' },
            { tenant: 8, id: 1, name: 'other-tenant' },
          ]);

          await knex.batchUpdate(
            'memberships',
            [
              { tenant: 7, id: 1, name: 'A' },
              { tenant: 7, id: 2, name: 'B' },
            ],
            ['tenant', 'id']
          );

          const rows = await knex('memberships').orderBy(['tenant', 'id']);
          // Number() coerces CockroachDB's int-as-string columns.
          expect(
            rows.map((r) => [Number(r.tenant), Number(r.id), r.name])
          ).to.eql([
            [7, 1, 'A'],
            [7, 2, 'B'],
            [8, 1, 'other-tenant'], // same id, different tenant — untouched
          ]);
          await knex.schema.dropTableIfExists('memberships');
        });

        it('rolls everything back when the caller transaction is rolled back', async function () {
          await knex
            .transaction(async (trx) => {
              await knex
                .batchUpdate('members', [{ id: 1, name: 'doomed', age: 0 }])
                .transacting(trx);
              throw new Error('force rollback');
            })
            .catch(() => {});

          const row = await knex('members').where('id', 1).first();
          expect(row.name).to.equal('old1'); // rollback reverted the update
        });

        it('validates the chunkSize parameter', function () {
          expect(() =>
            knex.batchUpdate('members', [{ id: 1, name: 'x' }], 'id', {
              chunkSize: 0,
            })
          ).to.throw('Invalid chunkSize: 0');
        });

        it('keeps the last row when a key is duplicated (last-write-wins)', async function () {
          await knex.batchUpdate('members', [
            { id: 1, name: 'first', age: 1 },
            { id: 1, name: 'last', age: 2 },
          ]);
          const row = await knex('members').where('id', 1).first();
          expect(row.name).to.equal('last');
          assertNumber(knex, row.age, 2);
        });

        it('throws on a duplicate key with onDuplicateKey: throw', function () {
          expect(() =>
            knex.batchUpdate(
              'members',
              [
                { id: 1, name: 'a', age: 1 },
                { id: 1, name: 'b', age: 2 },
              ],
              'id',
              { onDuplicateKey: 'throw' }
            )
          ).to.throw(/duplicate key/);
        });

        it('caps the chunk to the dialect bind-parameter limit', async function () {
          const rows = Array.from({ length: 10 }, (_, i) => ({
            id: i + 1,
            name: `n${i + 1}`,
            age: i,
          }));
          await knex('members').insert(rows.slice(3)); // 1-3 seeded already

          // Force a tiny limit: 6 params / 3 cells per row = 2 rows per chunk,
          // so 10 rows must split into ceil(10 / 2) = 5 statements regardless
          // of the (default 1000) chunkSize.
          const original = knex.client.maxBindParameters;
          knex.client.maxBindParameters = 6;
          const statements = [];
          const onQuery = (query) => {
            if (/^\s*(update|merge)\s/i.test(query.sql)) {
              statements.push(query.sql);
            }
          };
          knex.on('query', onQuery);
          try {
            await knex.batchUpdate(
              'members',
              rows.map((r) => ({ ...r, name: 'capped' }))
            );
          } finally {
            knex.off('query', onQuery);
            knex.client.maxBindParameters = original;
          }

          expect(statements).to.have.lengthOf(5);
          const updated = await knex('members')
            .where('name', 'capped')
            .count({ c: 'id' })
            .first();
          expect(Number(updated.c)).to.equal(10);
        });

        it("splits a union batch under SQLite's compound-SELECT term cap", async function () {
          // union emits one UNION ALL term per row; SQLite caps a compound SELECT
          // at 500 terms, well under the bind-parameter cap. Without the
          // per-dialect row cap a 600-row batch fails to compile ("too many terms
          // in compound SELECT"); with it, it splits into ceil(600 / 500) = 2.
          if (!isSQLite(knex)) {
            return this.skip();
          }
          const rows = Array.from({ length: 600 }, (_, i) => ({
            id: i + 1,
            name: `n${i + 1}`,
            age: i,
          }));
          // batchInsert (chunked) to seed — a single 597-row insert would hit the
          // same compound-SELECT cap.
          await knex.batchInsert('members', rows.slice(3), 100); // 1-3 seeded
          const statements = [];
          const onQuery = (query) => {
            if (/^\s*update\s/i.test(query.sql)) {
              statements.push(query.sql);
            }
          };
          knex.on('query', onQuery);
          try {
            await knex.batchUpdate(
              'members',
              rows.map((r) => ({ ...r, name: 'big' }))
            );
          } finally {
            knex.off('query', onQuery);
          }

          expect(statements).to.have.lengthOf(2);
          const updated = await knex('members')
            .where('name', 'big')
            .count({ c: 'id' })
            .first();
          expect(Number(updated.c)).to.equal(600);
        });

        // Large-batch correctness for every mode. These sizes cross each
        // dialect's per-statement limit — SQLite's 500 compound-SELECT terms and
        // expression depth, MSSQL's 2098 parameters, Oracle's 4000-byte json bind
        // — so they exercise the chunk loop and limit handling that the tiny
        // fixtures above never reach. Every bug the benchmark surfaced lived here.
        describe('at scale', function () {
          // Past SQLite's 500-term cap and MSSQL's ~524 rows/chunk, so union and
          // case span several chunks on the tightest dialects.
          const SCALE_ROWS = 1200;

          // The set-based statements get large at this size; the per-test 10s
          // default isn't enough on the networked dialects in CI.
          this.timeout(60000);

          const seedAndUpdate = async (mode, extraOptions) => {
            const rows = Array.from({ length: SCALE_ROWS }, (_, i) => ({
              id: i + 1,
              name: `old${i + 1}`,
              age: i,
            }));
            await knex.batchInsert('members', rows.slice(3), 100); // 1-3 seeded
            const updates = rows.map((r) => ({ ...r, name: `new${r.id}` }));
            await knex.batchUpdate('members', updates, 'id', {
              mode,
              ...extraOptions,
            });
            const updated = await knex('members')
              .where('name', 'like', 'new%')
              .count({ c: 'id' })
              .first();
            expect(Number(updated.c)).to.equal(SCALE_ROWS);
          };

          it('union updates every row across many chunks', async function () {
            await seedAndUpdate('union', {});
          });

          it('case updates every row across many chunks', async function () {
            await seedAndUpdate('case', {});
          });

          it('json updates every row (CLOB-split payload on oracle)', async function () {
            // JSON_TABLE / OPENJSON dialects need an explicit type map; pg
            // infers and SQLite is typeless.
            const columnTypes = isMysql(knex)
              ? { id: 'int', name: 'char(255)', age: 'int' }
              : isMssql(knex)
              ? { id: 'int', name: 'nvarchar(255)', age: 'int' }
              : isOracle(knex)
              ? { id: 'number', name: 'varchar2(255)', age: 'number' }
              : undefined;
            await seedAndUpdate('json', columnTypes ? { columnTypes } : {});
          });
        });
      });

      describe('batchUpdate binary (blob)', function () {
        this.timeout(60000);

        beforeEach(async () => {
          await knex.schema.dropTableIfExists('blobs');
          await knex.schema.createTable('blobs', (table) => {
            table.integer('id').primary();
            table.binary('data');
          });
          await knex('blobs').insert([
            { id: 1, data: Buffer.from('seed-1') },
            { id: 2, data: Buffer.from('seed-2') },
          ]);
        });

        after(async () => {
          await knex.schema.dropTableIfExists('blobs');
        });

        // Redshift has no bytea; binary batchUpdate throws there (asserted in the
        // unit suite). It isn't in the integration matrix, so nothing to skip.
        for (const mode of ['union', 'case']) {
          it(`round-trips a large blob in '${mode}' mode`, async function () {
            // 40 KB > Oracle's 4000-byte inline bind, so this exercises the
            // per-row LOB fallback there and the native binary bind elsewhere.
            const updates = [
              { id: 1, data: crypto.randomBytes(40000) },
              { id: 2, data: crypto.randomBytes(40000) },
            ];
            await knex.batchUpdate('blobs', updates, 'id', { mode });

            const rows = await knex('blobs').orderBy('id');
            expect(Buffer.from(rows[0].data).equals(updates[0].data)).to.equal(
              true
            );
            expect(Buffer.from(rows[1].data).equals(updates[1].data)).to.equal(
              true
            );
          });
        }

        it("rejects binary in 'json' mode", function () {
          expect(() =>
            knex.batchUpdate(
              'blobs',
              [{ id: 1, data: Buffer.from('x') }],
              'id',
              { mode: 'json' }
            )
          ).to.throw(/does not support binary/);
        });
      });
    });
  });
});
