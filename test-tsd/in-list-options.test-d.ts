import Knex from '../types';
import { clientConfig, User } from './common';
import { expectAssignable, expectError, expectType } from 'tsd';

const knex = Knex(clientConfig);

expectAssignable<Knex.Knex.Config>({
  client: 'pg',
  arrayParameterThreshold: 1000,
});
expectAssignable<Knex.Knex.Config>({
  client: 'pg',
  arrayParameterThreshold: null,
});

const main = async () => {
  expectType<User[]>(
    await knex<User>('users').whereIn('id', [1, 2], {
      arrayParameterThreshold: -1,
    })
  );

  expectType<User[]>(
    await knex<User>('users')
      .whereNotIn('id', [1, 2], { arrayParameterThreshold: null })
      .orWhereIn('id', [3, 4], { arrayParameterThreshold: undefined })
  );

  expectType<User[]>(
    await knex<User>('users')
      .groupBy('id')
      .havingIn('id', [1, 2], { arrayParameterThreshold: 1 })
      .orHavingIn('id', [3, 4], { arrayParameterThreshold: 1 })
      .andHavingIn('id', [5, 6], { arrayParameterThreshold: 1 })
  );

  expectType<User[]>(
    await knex<User>('users').join('contacts', (join) => {
      join.onIn('contacts.id', [1, 2], { arrayParameterThreshold: 1 });
    })
  );

  expectError(
    knex<User>('users').whereIn('id', [1, 2], { arrayParameterThreshold: '1' })
  );
  expectError(knex<User>('users').whereIn('id', [1, 2], { threshold: 1 }));
};
