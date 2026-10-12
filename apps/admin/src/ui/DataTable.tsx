import type { ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { EmptyState } from './States';
import { colors, space } from './theme';

export interface Column<Row> {
  key: string;
  header: string;
  /** Fixed width in px, or omit to share the remaining space. */
  width?: number;
  /** Relative share of the remaining space when `width` is omitted. */
  flex?: number;
  align?: 'left' | 'right';
  render: (row: Row, index: number) => ReactNode;
}

/**
 * A simple read-only table with proper roles. On narrow screens it scrolls sideways instead of squashing
 * the columns.
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  empty,
  minWidth = 640,
  label,
}: {
  columns: Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  empty?: ReactNode;
  minWidth?: number;
  label: string;
}): ReactNode {
  if (rows.length === 0) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ flexGrow: 1 }}>
      <View role="table" aria-label={label} style={{ minWidth, flexGrow: 1 }}>
        <View
          role="row"
          style={{
            flexDirection: 'row',
            backgroundColor: colors.page,
            borderBottomWidth: 2,
            borderBottomColor: colors.border,
          }}
        >
          {columns.map((column) => (
            <View
              key={column.key}
              role="columnheader"
              style={{
                ...(column.width ? { width: column.width } : { flex: column.flex ?? 1 }),
                paddingVertical: space[2],
                paddingHorizontal: space[3],
              }}
            >
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: '700',
                  color: colors.subtle,
                  textTransform: 'uppercase',
                  letterSpacing: 0.4,
                  textAlign: column.align ?? 'left',
                }}
              >
                {column.header}
              </Text>
            </View>
          ))}
        </View>
        {rows.map((row, index) => (
          <View
            key={rowKey(row)}
            role="row"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
              backgroundColor: index % 2 === 1 ? colors.page : colors.white,
            }}
          >
            {columns.map((column) => (
              <View
                key={column.key}
                role="cell"
                style={{
                  ...(column.width ? { width: column.width } : { flex: column.flex ?? 1 }),
                  paddingVertical: space[2],
                  paddingHorizontal: space[3],
                  alignItems: column.align === 'right' ? 'flex-end' : 'flex-start',
                }}
              >
                {column.render(row, index)}
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
