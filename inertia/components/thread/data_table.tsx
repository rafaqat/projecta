import type { ReactNode } from 'react'

/**
 * A column of a structured tabular view. The plain, non-interactive views declare their
 * columns and rows and share this one table, so they look the same and a new one is a column spec,
 * not fresh markup. Interactive views (expandable callers, dependency panels) keep their own
 * components.
 */
export interface Column<T> {
  key: string
  label: string
  /** Right-align a numeric column (line ranges, counts). */
  align?: 'left' | 'right'
  /** Render the cell in the monospace code style. */
  mono?: boolean
  /** A muted label column (the kind/method). */
  tone?: 'muted'
  /** A cell that is more than its plain value (a code span, a link, a badge). */
  render?: (row: T) => ReactNode
}

export function DataTable<T>({
  component,
  className,
  columns,
  rows,
  rowKey,
}: {
  /** The view id, exposed as `data-component` for tests and for the decision record. */
  component: string
  /** Extra class on the table (keeps per-view CSS hooks like `file-outline`). */
  className?: string
  columns: Array<Column<T>>
  rows: T[]
  rowKey: (row: T, index: number) => string
}) {
  const cell = (col: Column<T>, row: T): ReactNode => {
    if (col.render) return col.render(row)
    const value = (row as Record<string, unknown>)[col.key]
    const text = value === null || value === undefined ? '' : String(value)
    return col.mono ? <code>{text}</code> : text
  }
  return (
    <table className={`view${className ? ` ${className}` : ''}`} data-component={component}>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.key} data-align={col.align ?? undefined}>
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={rowKey(row, i)}>
            {columns.map((col) => (
              <td
                key={col.key}
                data-align={col.align ?? undefined}
                data-tone={col.tone ?? undefined}
              >
                {cell(col, row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
