// $1 -> index 1, $2 -> index 2, ...
export type Expression =
  | Expression.ColumnRef
  | Expression.TableColumnRef
  | Expression.SchemaTableColumnRef
  | Expression.Constant
  | Expression.Positional
  | Expression.UnaryOp
  | Expression.BinaryOp

export namespace Expression {
  export type ColumnRef = {
    kind: 'ColumnRef'
    column: string
  }

  export function createColumnRef(column: string): ColumnRef {
    return { kind: 'ColumnRef', column }
  }

  export function isColumnRef(expr: Expression): expr is ColumnRef {
    return expr.kind === 'ColumnRef'
  }

  export type TableColumnRef = {
    kind: 'TableColumnRef'
    table: string
    column: string
  }

  export function createTableColumnRef(
    table: string,
    column: string
  ): TableColumnRef {
    return { kind: 'TableColumnRef', table, column }
  }

  export function isTableColumnRef(expr: Expression): expr is TableColumnRef {
    return expr.kind === 'TableColumnRef'
  }

  export type SchemaTableColumnRef = {
    kind: 'SchemaTableColumnRef'
    schema: string
    table: string
    column: string
  }

  export function createSchemaTableColumnRef(
    schema: string,
    table: string,
    column: string
  ): SchemaTableColumnRef {
    return { kind: 'SchemaTableColumnRef', schema, table, column }
  }

  export function isSchemaTableColumnRef(
    expr: Expression
  ): expr is SchemaTableColumnRef {
    return expr.kind === 'SchemaTableColumnRef'
  }

  export type AnyColumnRef = SchemaTableColumnRef | TableColumnRef | ColumnRef

  export function isAnyColumnRef(expr: Expression): expr is AnyColumnRef {
    return (
      isSchemaTableColumnRef(expr) ||
      isTableColumnRef(expr) ||
      isColumnRef(expr)
    )
  }

  export type Constant = {
    kind: 'Constant'
    value: string
  }

  export function createConstant(value: string): Constant {
    return { kind: 'Constant', value }
  }

  export function isConstant(expr: Expression): expr is Constant {
    return expr.kind === 'Constant'
  }

  export type Positional = {
    kind: 'Positional'
    index: number
  }

  export function createPositional(index: number): Positional {
    return { kind: 'Positional', index }
  }

  export function isPositional(expr: Expression): expr is Positional {
    return expr.kind === 'Positional'
  }

  export type UnaryOp = {
    kind: 'UnaryOp'
    op: string
    expression: Expression
  }

  export function createUnaryOp(op: string, expression: Expression): UnaryOp {
    return { kind: 'UnaryOp', op, expression }
  }

  export function isUnaryOp(expr: Expression): expr is UnaryOp {
    return expr.kind === 'UnaryOp'
  }

  export type BinaryOp = {
    kind: 'BinaryOp'
    lhs: Expression
    op: string
    rhs: Expression
  }

  export function createBinaryOp(
    lhs: Expression,
    op: string,
    rhs: Expression
  ): BinaryOp {
    return { kind: 'BinaryOp', lhs, op, rhs }
  }

  export function isBinaryOp(expr: Expression): expr is BinaryOp {
    return expr.kind === 'BinaryOp'
  }
}

export type SelectListItem = {
  expression: Expression
  as: string | null
}

export namespace SelectListItem {
  export function create(
    expression: Expression,
    as: string | null
  ): SelectListItem {
    return { expression, as }
  }
}

export type Join = {
  kind: 'JOIN'
  joinType: Join.JoinType
  table: TableRef
  as: string | null
  condition: Expression
}

export namespace Join {
  export type JoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL'

  export function create(
    joinType: JoinType,
    table: TableRef,
    as: string | null,
    condition: Expression
  ): Join {
    return { kind: 'JOIN', joinType, table, as, condition }
  }
}

export type TableRef = { schema: string | null; table: string }

export type From = {
  table: TableRef
  as: string | null
  joins: Join[]
}

export namespace From {
  export function create(
    table: TableRef,
    as: string | null,
    joins: Join[]
  ): From {
    return { table, as, joins }
  }
}

export type OrderBy = {
  expression: Expression
  order: OrderBy.Order | null
  nulls: OrderBy.Nulls | null
}

export namespace OrderBy {
  export type Order = 'ASC' | 'DESC' | ['USING', string]
  export type Nulls = 'FIRST' | 'LAST'

  export function create(
    expression: Expression,
    order: Order | null,
    nulls: Nulls | null
  ): OrderBy {
    return { expression, order, nulls }
  }
}

export type Select = {
  selectList: SelectListItem[]
  from: From | null
  orderBy: OrderBy[]
}

export namespace Select {
  export function create(
    selectList: SelectListItem[],
    from: From | null,
    orderBy: OrderBy[]
  ): Select {
    return { selectList, from, orderBy }
  }
}

export type AST = Select
