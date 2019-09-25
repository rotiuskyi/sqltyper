import * as R from 'ramda'

import * as Array from 'fp-ts/lib/Array'
import * as Either from 'fp-ts/lib/Either'
import * as Option from 'fp-ts/lib/Option'
import * as TaskEither from 'fp-ts/lib/TaskEither'
import { identity } from 'fp-ts/lib/function'
import { pipe } from 'fp-ts/lib/pipeable'

import * as ast from './ast'
import { sequenceAE, sequenceATE } from './fp-utils'
import { functionNullSafety, operatorNullSafety } from './const-utils'
import { parse } from './parser'
import { SchemaClient, Table, Column } from './schema'
import { StatementDescription, StatementRowCount, ValueType } from './types'

type FieldNullability =
  | { kind: 'Any'; nullable: boolean }
  | { kind: 'Array'; nullable: boolean; elemNullable: boolean }

function any(nullable: boolean): FieldNullability {
  return { kind: 'Any', nullable }
}

function array(nullable: boolean, elemNullable: boolean): FieldNullability {
  return { kind: 'Array', nullable, elemNullable }
}

export type SourceColumn = {
  tableAlias: string
  columnName: string
  nullability: FieldNullability
  hidden: boolean
}

export type VirtualField = {
  name: string
  nullability: FieldNullability
}

function virtualField(
  name: string,
  nullability: FieldNullability
): VirtualField {
  return { name, nullability }
}

export type VirtualTable = {
  name: string
  columns: VirtualField[]
}

export function inferStatementNullability(
  client: SchemaClient,
  verbose: boolean,
  statement: StatementDescription
): TaskEither.TaskEither<string, StatementDescription> {
  return pipe(
    TaskEither.fromEither(parse(statement.sql)),
    TaskEither.chain(astNode =>
      pipe(
        inferColumnNullability(client, statement, astNode),
        TaskEither.chain(stmt => inferParamNullability(client, stmt, astNode)),
        TaskEither.map(stmt => inferRowCount(stmt, astNode))
      )
    ),
    TaskEither.orElse(parseErrorStr => {
      // tslint-disable:no-console
      console.warn(`
WARNING: The internal SQL parser failed to parse the SQL statement. The
inferred types may be inaccurate with respect to nullability.
`)
      if (verbose) {
        console.warn(`\
Parse error: ${parseErrorStr}

Please open an issue on https://github.com/akheron/sqltyper.

Include the above error message, relevant parts of your database
schema (CREATE TABLE statements, CREATE TYPE statements, etc.) and the
SQL statement that failed to parse.

Thank you in advance!
`)
      } else {
        console.warn(`\
Re-run with --verbose for instructions on how to report or fix this.
`)
      }
      // tslint-enable:no-console
      return TaskEither.right(statement)
    })
  )
}

export function inferColumnNullability(
  client: SchemaClient,
  statement: StatementDescription,
  tree: ast.AST
): TaskEither.TaskEither<string, StatementDescription> {
  return pipe(
    getOutputColumns(client, [], tree),
    TaskEither.chain(outputColumns =>
      TaskEither.fromEither(applyColumnNullability(statement, outputColumns))
    )
  )
}

function getOutputColumns(
  client: SchemaClient,
  outsideCTEs: VirtualTable[],
  tree: ast.AST
): TaskEither.TaskEither<string, VirtualField[]> {
  return ast.walk(tree, {
    select: ({ ctes, body }) =>
      pipe(
        combineVirtualTables(
          outsideCTEs,
          getVirtualTablesForWithQueries(client, ctes)
        ),
        TaskEither.chain(combinedCTEs =>
          pipe(
            getSourceColumnsForTableExpr(client, combinedCTEs, body.from),
            TaskEither.chain(sourceColumns =>
              inferSelectListOutput(
                client,
                combinedCTEs,
                sourceColumns,
                body.where,
                body.selectList
              )
            )
          )
        )
      ),
    insert: ({ table, as, returning }) =>
      pipe(
        getSourceColumnsForTable(client, outsideCTEs, table, as),
        TaskEither.chain(sourceColumns =>
          inferSelectListOutput(
            client,
            outsideCTEs,
            sourceColumns,
            null,
            returning
          )
        )
      ),
    update: ({ ctes, table, as, from, where, returning }) =>
      pipe(
        combineVirtualTables(
          outsideCTEs,
          getVirtualTablesForWithQueries(client, ctes)
        ),
        TaskEither.chain(combinedCTEs =>
          combineSourceColumns(
            getSourceColumnsForTableExpr(client, combinedCTEs, from),
            getSourceColumnsForTable(client, combinedCTEs, table, as)
          )
        ),
        TaskEither.chain(sourceColumns =>
          inferSelectListOutput(
            client,
            outsideCTEs,
            sourceColumns,
            where,
            returning
          )
        )
      ),
    delete: ({ table, as, where, returning }) =>
      pipe(
        getSourceColumnsForTable(client, outsideCTEs, table, as),
        TaskEither.chain(sourceColumns =>
          inferSelectListOutput(
            client,
            outsideCTEs,
            sourceColumns,
            where,
            returning
          )
        )
      ),
  })
}

function applyColumnNullability(
  stmt: StatementDescription,
  outputColumns: VirtualField[]
): Either.Either<string, StatementDescription> {
  if (outputColumns.length != stmt.columns.length) {
    return Either.left(`BUG: Non-equal number of columns: \
inferred ${outputColumns.length}, actual ${stmt.columns.length}`)
  }

  const inferredColumnNames = outputColumns.map(({ name }) => name).join(', ')
  const actualColumnNames = stmt.columns.map(({ name }) => name).join(', ')

  if (inferredColumnNames != actualColumnNames) {
    return Either.left(`BUG: Inferred output column names do not equal \
actual output column names: inferred "${inferredColumnNames}", \
actual: "${actualColumnNames}"`)
  }

  return Either.right({
    ...stmt,
    columns: R.zipWith(
      (column, inferred) => {
        switch (inferred.nullability.kind) {
          case 'Any':
            return {
              ...column,
              nullable: inferred.nullability.nullable,
            }

          case 'Array':
            return {
              ...column,
              type: ValueType.array(
                column.type.oid,
                inferred.nullability.elemNullable
              ),
              nullable: inferred.nullability.nullable,
            }
        }
      },
      stmt.columns,
      outputColumns
    ),
  })
}

function inferSelectListOutput(
  client: SchemaClient,
  outsideCTEs: VirtualTable[],
  sourceColumns: SourceColumn[],
  where: ast.Expression | null,
  selectList: ast.SelectListItem[]
): TaskEither.TaskEither<string, VirtualField[]> {
  return pipe(
    TaskEither.right(getNonNullExpressionsFromWhere(where)),
    TaskEither.chain(nonNullExpressions =>
      pipe(
        selectList.map(item =>
          inferSelectListItemOutput(
            client,
            outsideCTEs,
            sourceColumns,
            nonNullExpressions,
            item
          )
        ),
        sequenceATE,
        TaskEither.map(R.flatten)
      )
    )
  )
}

function inferSelectListItemOutput(
  client: SchemaClient,
  outsideCTEs: VirtualTable[],
  sourceColumns: SourceColumn[],
  nonNullExpressions: ast.Expression[],
  selectListItem: ast.SelectListItem
): TaskEither.TaskEither<string, VirtualField[]> {
  return ast.SelectListItem.walk<TaskEither.TaskEither<string, VirtualField[]>>(
    selectListItem,
    {
      allFields: () =>
        TaskEither.fromEither(
          pipe(
            // hidden columns aren't selected by SELECT *
            findNonHiddenSourceColumns(sourceColumns),
            Either.map(columns =>
              applyExpressionNonNullability(nonNullExpressions, columns)
            ),
            Either.map(columns =>
              columns.map(column => ({
                name: column.columnName,
                nullability: column.nullability,
              }))
            )
          )
        ),

      allTableFields: ({ tableName }) =>
        TaskEither.fromEither(
          pipe(
            findNonHiddenSourceTableColumns(tableName, sourceColumns),
            Either.map(columns =>
              applyExpressionNonNullability(nonNullExpressions, columns)
            ),
            Either.map(columns =>
              columns.map(column => ({
                name: column.columnName,
                nullability: column.nullability,
              }))
            )
          )
        ),

      selectListExpression: ({ expression, as }) =>
        pipe(
          inferExpressionNullability(
            client,
            outsideCTEs,
            sourceColumns,
            nonNullExpressions,
            expression
          ),
          TaskEither.map(exprNullability => [
            virtualField(
              as || inferExpressionName(expression),
              exprNullability
            ),
          ])
        ),
    }
  )
}

type NonNullableColumn = { tableName: string | null; columnName: string }

function isColumnNonNullable(
  nonNullableColumns: NonNullableColumn[],
  sourceColumn: SourceColumn
): boolean {
  return nonNullableColumns.some(nonNull =>
    nonNull.tableName
      ? sourceColumn.tableAlias === nonNull.tableName
      : true && sourceColumn.columnName === nonNull.columnName
  )
}

function applyExpressionNonNullability(
  nonNullableExpressions: ast.Expression[],
  sourceColumns: SourceColumn[]
): SourceColumn[] {
  const nonNullableColumns = pipe(
    nonNullableExpressions,
    R.map(expr =>
      ast.Expression.walkSome<Option.Option<NonNullableColumn>>(
        expr,
        Option.none,
        {
          columnRef: ({ column }) =>
            Option.some({ tableName: null, columnName: column }),
          tableColumnRef: ({ table, column }) =>
            Option.some({ tableName: table, columnName: column }),
        }
      )
    ),
    Array.filterMap(identity)
  )
  return sourceColumns.map(sourceColumn => ({
    ...sourceColumn,
    nullability: isColumnNonNullable(nonNullableColumns, sourceColumn)
      ? any(false)
      : sourceColumn.nullability,
  }))
}

function inferExpressionName(expression: ast.Expression): string {
  return ast.Expression.walkSome(expression, '?column?', {
    columnRef: ({ column }) => column,
    tableColumnRef: ({ column }) => column,
  })
}

function anyTE(
  nullable: boolean
): TaskEither.TaskEither<string, FieldNullability> {
  return TaskEither.right(any(nullable))
}

function arrayTE(
  nullable: boolean,
  elemNullable: boolean
): TaskEither.TaskEither<string, FieldNullability> {
  return TaskEither.right(array(nullable, elemNullable))
}

function inferExpressionNullability(
  client: SchemaClient,
  outsideCTEs: VirtualTable[],
  sourceColumns: SourceColumn[],
  nonNullExprs: ast.Expression[],
  expression: ast.Expression
): TaskEither.TaskEither<string, FieldNullability> {
  if (
    nonNullExprs.some(nonNull => ast.Expression.equals(expression, nonNull))
  ) {
    // This expression is guaranteed to be not NULL by a
    // `WHERE expr IS NOT NULL` clause
    return anyTE(false)
  }
  return ast.Expression.walk<TaskEither.TaskEither<string, FieldNullability>>(
    expression,
    {
      // A column reference may evaluate to NULL if the column doesn't
      // have a NOT NULL constraint
      tableColumnRef: ({ table, column }) =>
        pipe(
          TaskEither.fromEither(
            findSourceTableColumn(table, column, sourceColumns)
          ),
          TaskEither.map(column => column.nullability)
        ),

      // A column reference may evaluate to NULL if the column doesn't
      // have a NOT NULL constraint
      columnRef: ({ column }) =>
        pipe(
          TaskEither.fromEither(findSourceColumn(column, sourceColumns)),
          TaskEither.map(column => column.nullability)
        ),

      // A unary operator has two options:
      //
      // - The operator is known to be NULL safe: it returns NULL only
      //   if its operand is NULL
      //
      // - The operator is not NULL safe: it can return NULL even if its
      // - operand is not NULL
      unaryOp: ({ op, operand }) => {
        switch (operatorNullSafety(op)) {
          case 'safe':
            return inferExpressionNullability(
              client,
              outsideCTEs,
              sourceColumns,
              nonNullExprs,
              operand
            )
          case 'unsafe':
          case 'alwaysNull':
            return anyTE(true)
          case 'neverNull':
            return anyTE(false)
        }
      },

      // A binary operator has two options:
      //
      // - The operator is known to be NULL safe: it returns NULL only
      //   if any of its operands is NULL
      //
      // - The function is not NULL safe: it can return NULL even if all
      //   of its operands are non-NULL
      binaryOp: ({ op, lhs, rhs }) => {
        switch (operatorNullSafety(op)) {
          case 'safe':
            return pipe(
              TaskEither.right(
                (lhsNullability: FieldNullability) => (
                  rhsNullability: FieldNullability
                ) => any(lhsNullability.nullable || rhsNullability.nullable)
              ),
              TaskEither.ap(
                inferExpressionNullability(
                  client,
                  outsideCTEs,
                  sourceColumns,
                  nonNullExprs,
                  lhs
                )
              ),
              TaskEither.ap(
                inferExpressionNullability(
                  client,
                  outsideCTEs,
                  sourceColumns,
                  nonNullExprs,
                  rhs
                )
              )
            )
          case 'unsafe':
          case 'alwaysNull':
            return anyTE(true)
          case 'neverNull':
            return anyTE(false)
        }
      },

      // EXISTS (subquery) never returns NULL
      existsOp: () => anyTE(false),

      // A function call has two options:
      //
      // - The function is known to be NULL safe: it returns NULL only
      //   if any of its arguments is NULL
      //
      // - The function is not NULL safe: it can return NULL even if all
      //   of its arguments are non-NULL
      //
      functionCall: ({ funcName, argList }) => {
        switch (functionNullSafety(funcName)) {
          case 'safe':
            return pipe(
              argList.map(arg =>
                inferExpressionNullability(
                  client,
                  outsideCTEs,
                  sourceColumns,
                  nonNullExprs,
                  arg
                )
              ),
              sequenceATE,
              TaskEither.chain(argNullability =>
                anyTE(argNullability.some(nullability => nullability.nullable))
              )
            )
          case 'unsafe':
          case 'alwaysNull':
            return anyTE(true)
          case 'neverNull':
            return anyTE(false)
        }
      },

      // expr IN (subquery) returns NULL if expr is NULL
      inOp: ({ lhs }) =>
        inferExpressionNullability(
          client,
          outsideCTEs,
          sourceColumns,
          nonNullExprs,
          lhs
        ),

      // ARRAY(subquery) is never null as a whole. The nullability of
      // the inside depends on the inside select list expression
      arraySubQuery: ({ subquery }) =>
        pipe(
          getOutputColumns(client, outsideCTEs, subquery),
          TaskEither.chain(columns => {
            if (columns.length != 1)
              return TaskEither.left('subquery must return only one column')
            return arrayTE(
              // An array constructed from a subquery is never NULL itself
              false,
              // Element nullability depends on the subquery column nullability
              columns[0].nullability.nullable
            )
          })
        ),

      // A type cast evaluates to NULL if the expression to be casted is
      // NULL.
      typeCast: ({ lhs }) =>
        inferExpressionNullability(
          client,
          outsideCTEs,
          sourceColumns,
          nonNullExprs,
          lhs
        ),

      // A constant is never NULL
      constant: () => anyTE(false),

      // A parameter can be NULL
      parameter: () => anyTE(true),
    }
  )
}

function getNonNullExpressionsFromWhere(
  where: ast.Expression | null
): ast.Expression[] {
  if (where == null) {
    return []
  }
  return ast.Expression.walkSome<ast.Expression[]>(where, [], {
    binaryOp: ({ lhs, op, rhs }) => {
      if (op === 'AND') {
        return [
          ...getNonNullExpressionsFromWhere(lhs),
          ...getNonNullExpressionsFromWhere(rhs),
        ]
      }
      if (operatorNullSafety(op) === 'safe') {
        return [lhs, rhs]
      }
      return []
    },
    unaryOp: ({ op, operand }) => {
      if (op === 'IS NOT NULL' || op === 'NOTNULL') {
        return [operand]
      }
      return []
    },
    functionCall: ({ funcName, argList }) => {
      if (functionNullSafety(funcName) === 'safe') {
        return argList
      }
      return []
    },
  })
}

function inferParamNullability(
  client: SchemaClient,
  statement: StatementDescription,
  tree: ast.AST
): TaskEither.TaskEither<string, StatementDescription> {
  return pipe(
    getParamNullability(client, tree),
    TaskEither.chain(paramNullability =>
      paramNullability
        ? TaskEither.fromEither(
            applyParamNullability(statement, paramNullability)
          )
        : TaskEither.right(statement)
    )
  )
}

// index 0 means param $1, index 1 means param $2, etc.
type ParamNullability = { index: number; nullable: boolean }

function getParamNullability(
  client: SchemaClient,
  tree: ast.AST
): TaskEither.TaskEither<string, ParamNullability[] | null> {
  return ast.walk<TaskEither.TaskEither<string, ParamNullability[] | null>>(
    tree,
    {
      select: () => TaskEither.right(null),
      insert: ({ table, columns, values }) =>
        pipe(
          TaskEither.right(combineParamNullability),
          TaskEither.ap(
            TaskEither.right(findParamsFromValues(values, columns.length))
          ),
          TaskEither.ap(findInsertColumns(client, table, columns))
        ),
      update: ({ table, updates }) =>
        findParamNullabilityFromUpdates(client, table, updates),
      delete: () => TaskEither.right(null),
    }
  )
}

function findParamsFromValues(
  values: ast.Values,
  numInsertColumns: number
): Array<Array<Option.Option<number>>> {
  return ast.Values.walk(values, {
    defaultValues: () => [R.repeat(Option.none, numInsertColumns)],
    exprValues: ({ valuesList }) =>
      valuesList.map(values => values.map(paramIndexFromExpr)),
  })
}

function findParamNullabilityFromUpdates(
  client: SchemaClient,
  table: ast.TableRef,
  updates: ast.UpdateAssignment[]
): TaskEither.TaskEither<string, ParamNullability[]> {
  return pipe(
    client.getTable(table.schema, table.table),
    TaskEither.chain(dbTable =>
      TaskEither.fromEither(
        pipe(
          updates.map(update => updateToParamNullability(dbTable, update)),
          sequenceAE
        )
      )
    ),
    TaskEither.map(paramNullabilities =>
      pipe(
        paramNullabilities,
        Array.filterMap(identity)
      )
    )
  )
}

function paramIndexFromExpr(
  expression: ast.Expression | null
): Option.Option<number> {
  return pipe(
    Option.fromNullable(expression),
    Option.chain(nonNullExpr =>
      ast.Expression.walkSome(nonNullExpr, Option.none, {
        parameter: paramExpr => Option.some(paramExpr.index - 1),
      })
    )
  )
}

function updateToParamNullability(
  dbTable: Table,
  update: ast.UpdateAssignment
): Either.Either<string, Option.Option<ParamNullability>> {
  return pipe(
    Either.right(makeParamNullability),
    Either.ap(Either.right(paramIndexFromExpr(update.value))),
    Either.ap(findTableColumn(update.columnName, dbTable))
  )
}

const makeParamNullability = (index: Option.Option<number>) => (
  column: Column
): Option.Option<ParamNullability> =>
  pipe(
    index,
    Option.map(index => ({ index, nullable: column.nullable }))
  )

function findInsertColumns(
  client: SchemaClient,
  table: ast.TableRef,
  columnNames: string[]
): TaskEither.TaskEither<string, Column[]> {
  return pipe(
    client.getTable(table.schema, table.table),
    TaskEither.chain(dbTable =>
      TaskEither.fromEither(
        pipe(
          columnNames.map(columnName => findTableColumn(columnName, dbTable)),
          sequenceAE
        )
      )
    )
  )
}

const combineParamNullability = (
  valuesListParams: Array<Array<Option.Option<number>>>
) => (targetColumns: Column[]): ParamNullability[] => {
  return pipe(
    valuesListParams.map(valuesParams =>
      R.zip(targetColumns, valuesParams).map(([column, param]) =>
        pipe(
          param,
          Option.map(index => ({ index, nullable: column.nullable }))
        )
      )
    ),
    R.flatten,
    Array.filterMap(identity)
  )
}

function applyParamNullability(
  stmt: StatementDescription,
  paramNullability: ParamNullability[]
): Either.Either<string, StatementDescription> {
  // paramNullability may contain multiple records for each param. If
  // any of the records states that the param is nullable, then it is
  // nullable.
  const nullability = R.range(0, stmt.params.length).map(index =>
    paramNullability
      .filter(record => record.index === index)
      .some(record => record.nullable)
  )
  return Either.right({
    ...stmt,
    params: R.zipWith(
      (param, nullable) => ({ ...param, nullable }),
      stmt.params,
      nullability
    ),
  })
}

function inferRowCount(
  statement: StatementDescription,
  astNode: ast.AST
): StatementDescription {
  const rowCount: StatementRowCount = ast.walk(astNode, {
    select: ({ limit }) =>
      limit && limit.count && isConstantExprOf('1', limit.count)
        ? 'zeroOrOne' // LIMIT 1 => zero or one rows
        : 'many',

    insert: ({ values, returning }) =>
      ast.Values.walk(values, {
        // INSERT INTO xxx DEFAULT VALUES always creates a single row
        defaultValues: () => 'one',
        exprValues: exprValues =>
          returning.length
            ? // Check the length of the VALUES expression list
              exprValues.valuesList.length === 1
              ? 'one'
              : 'many'
            : // No RETURNING, no output
              'zero',
      }),

    update: ({ returning }) =>
      returning.length
        ? 'many'
        : // No RETURNING, no output
          'zero',

    delete: ({ returning }) =>
      returning.length
        ? 'many'
        : // No RETURNING, no output
          'zero',
  })

  return { ...statement, rowCount }
}

function getVirtualTablesForWithQueries(
  client: SchemaClient,
  withQueries: ast.WithQuery[]
): TaskEither.TaskEither<string, VirtualTable[]> {
  return async () => {
    const virtualTables: VirtualTable[] = []
    for (const withQuery of withQueries) {
      // "Virtual tables" from previous WITH queries are available
      const virtualTable = pipe(
        await getOutputColumns(client, virtualTables, withQuery.query)(),
        Either.map(columns => ({ name: withQuery.as, columns }))
      )
      if (Either.isLeft(virtualTable)) {
        return virtualTable
      }
      virtualTables.push(virtualTable.right)
    }
    return Either.right(virtualTables)
  }
}

function combineVirtualTables(
  outsideCTEs: VirtualTable[],
  ctes: TaskEither.TaskEither<string, VirtualTable[]>
): TaskEither.TaskEither<string, VirtualTable[]> {
  return pipe(
    ctes,
    TaskEither.map(virtualTables => [...outsideCTEs, ...virtualTables])
  )
}

function getSourceColumnsForTable(
  client: SchemaClient,
  ctes: VirtualTable[],
  table: ast.TableRef,
  as: string | null
): TaskEither.TaskEither<string, SourceColumn[]> {
  if (table.schema == null) {
    // Try to find a matching CTE
    const result = ctes.find(virtualTable => virtualTable.name === table.table)
    if (result)
      return TaskEither.right(
        result.columns.map(col => ({
          tableAlias: as || table.table,
          columnName: col.name,
          nullability: col.nullability,
          hidden: false,
        }))
      )
  }

  // No matching CTE, try to find a database table
  return pipe(
    client.getTable(table.schema, table.table),
    TaskEither.map(table =>
      table.columns.map(col => ({
        tableAlias: as || table.name,
        columnName: col.name,
        nullability: any(col.nullable),
        hidden: col.hidden,
      }))
    )
  )
}

function getSourceColumnsForTableExpr(
  client: SchemaClient,
  ctes: VirtualTable[],
  tableExpr: ast.TableExpression | null,
  setNullable: boolean = false
): TaskEither.TaskEither<string, SourceColumn[]> {
  if (!tableExpr) {
    return TaskEither.right([])
  }

  return pipe(
    ast.TableExpression.walk(tableExpr, {
      table: ({ table, as }) =>
        getSourceColumnsForTable(client, ctes, table, as),
      subQuery: ({ query, as }) =>
        getSourceColumnsForSubQuery(client, ctes, query, as),
      crossJoin: ({ left, right }) =>
        combineSourceColumns(
          getSourceColumnsForTableExpr(client, ctes, left, false),
          getSourceColumnsForTableExpr(client, ctes, right, false)
        ),
      qualifiedJoin: ({ left, joinType, right }) =>
        combineSourceColumns(
          getSourceColumnsForTableExpr(
            client,
            ctes,
            left,
            // RIGHT or FULL JOIN -> The left side columns becomes nullable
            joinType === 'RIGHT' || joinType === 'FULL'
          ),
          getSourceColumnsForTableExpr(
            client,
            ctes,
            right,
            // LEFT or FULL JOIN -> The right side columns becomes nullable
            joinType === 'LEFT' || joinType === 'FULL'
          )
        ),
    }),
    TaskEither.map(sourceColumns =>
      setNullable ? setSourceColumnsAsNullable(sourceColumns) : sourceColumns
    )
  )
}

function getSourceColumnsForSubQuery(
  client: SchemaClient,
  outsideCTEs: VirtualTable[],
  subquery: ast.AST,
  as: string
): TaskEither.TaskEither<string, SourceColumn[]> {
  return pipe(
    getOutputColumns(client, outsideCTEs, subquery),
    TaskEither.map(columns =>
      columns.map(column => ({
        tableAlias: as,
        columnName: column.name,
        nullability: column.nullability,
        hidden: false,
      }))
    )
  )
}

function setSourceColumnsAsNullable(
  sourceColumns: SourceColumn[]
): SourceColumn[] {
  return sourceColumns.map(col => ({
    ...col,
    nullability: { ...col.nullability, nullable: true },
  }))
}

function combineSourceColumns(
  ...sourceColumns: Array<TaskEither.TaskEither<string, SourceColumn[]>>
): TaskEither.TaskEither<string, SourceColumn[]> {
  return pipe(
    sourceColumns,
    sequenceATE,
    TaskEither.map(R.flatten)
  )
}

function isConstantExprOf(expectedValue: string, expr: ast.Expression) {
  return ast.Expression.walkSome(expr, false, {
    constant: ({ valueText }) => valueText === expectedValue,
  })
}

function findNonHiddenSourceColumns(
  sourceColumns: SourceColumn[]
): Either.Either<string, SourceColumn[]> {
  return pipe(
    sourceColumns.filter(col => !col.hidden),
    Either.fromPredicate(result => result.length > 0, () => `No columns`)
  )
}

function findNonHiddenSourceTableColumns(
  tableName: string,
  sourceColumns: SourceColumn[]
): Either.Either<string, SourceColumn[]> {
  return pipe(
    findNonHiddenSourceColumns(sourceColumns),
    Either.map(sourceColumns =>
      sourceColumns.filter(col => col.tableAlias === tableName)
    ),
    Either.chain(result =>
      result.length > 0
        ? Either.right(result)
        : Either.left(`No visible columns for table ${tableName}`)
    )
  )
}

function findSourceTableColumn(
  tableName: string,
  columnName: string,
  sourceColumns: SourceColumn[]
): Either.Either<string, SourceColumn> {
  return pipe(
    sourceColumns.find(
      source =>
        source.tableAlias === tableName && source.columnName === columnName
    ),
    Either.fromNullable(`Unknown column ${tableName}.${columnName}`)
  )
}

function findSourceColumn(
  columnName: string,
  sourceColumns: SourceColumn[]
): Either.Either<string, SourceColumn> {
  return pipe(
    sourceColumns.find(col => col.columnName === columnName),
    Either.fromNullable(`Unknown column ${columnName}`)
  )
}

function findTableColumn(columnName: string, table: Table) {
  return pipe(
    table.columns.find(column => column.name === columnName),
    Either.fromNullable(`Unknown column ${columnName}`)
  )
}
