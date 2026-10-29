---
name: reference_knex_naming_comment_conventions
description: knex/knex code conventions — function/method naming and comment style, derived from reading lib/ (use when writing knex code or reviewing a knex PR)
metadata:
  type: reference
---

knex code conventions, observed across `lib/` (counts from a full grep, not a guess). Match these when adding to the knex repo — maintainers gate on "same coding style as the rest of the codebase".

## Naming

- **camelCase** functions/methods; **PascalCase** only for constructors/classes (`QueryCompiler`, `BlobHelper`, `ReturningHelper`).
- **Public chainable API methods are named after the SQL keyword, lowercase**: `select`, `insert`, `update`, `where`, `columns`, `truncate`. Exception kept for JS reserved words: `del` (not `delete`), `first`/`pluck` alias to `select`.
- **Leading `_` marks private/internal** methods and module-local helpers (`_batchUpdateFromSelect`, `_buildInsertValues`, `_insertBody`, `_createMigrationTable`, `_preValidate`). It's the minority (~178 of ~2960 method defs) — only the genuinely internal surface gets it; public API stays bare.
- **Boolean predicates prefixed `is`/`has`**: `isString`, `isConnectionError`, `isValid`, `hasTable`, `hasColumn`. `is*`/`has*` dominate; `should*`/`can*` essentially unused. Predicate helpers live in `lib/util/is.js`.
- **Trailing `_` on aliased imports that would shadow a local method**: `columnize_`, `wrap_`, `unwrapRaw_`, `rawOrFn_` (imported from `wrappingFormatter`, the method on the class keeps the clean name).
- **Internal compile steps are verb/noun camelCase**: `compile*`, `columnDefinition`, `columnNameList`, `arrayToList`, `bufferToString`.

## Comments

- **Line comments `//` are the convention; JSDoc is not** (~1377 line-comment lines vs ~37 `/**` blocks across `lib/`). Do not add JSDoc `@param`/`@returns` blocks — write a plain `//` above the method.
- **File + section banner = two lines**: a title then a dash divider, e.g. `// Query Compiler` / `// -------`. Sections *within* a file repeat it (`// Select` / `// ------`, `// With` / `// ------`).
- **A method's lead comment states WHAT it does in present tense**, terse: "Adds a column or columns to the list of 'columns' being selected on the query.", "Prepends the `schemaName` on `tableName`.", "Create a shallow clone of the current query builder."
- **Inline `//` carry the non-obvious WHY**, not restated code: "`_option` is assigned by the `Interface` mixin.", "Validated as two-arg variant (alias, statement)."
- **Backtick code identifiers inside comments**: `` `schemaName` ``, `` `.table` ``, `` `knex.builder` ``.
- **Multi-key option docs as an indented sub-bullet list in the comment** (e.g. the `into()` options block lists `- only:` etc.).
- **File-level eslint directive at top when a file needs it**: `/* eslint max-len:0 */`.

Cross-refs to jean's own rules these align with: [[feedback_fewer_comments]] (comment only the non-obvious why), [[feedback_name_covers_full_scope]] (is/has predicate naming), [[feedback_inline_comment_position]] (lead comment sits on the method).
