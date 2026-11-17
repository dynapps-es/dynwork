/** A plugin's `t` over one table: `{{name}}` placeholders, the key itself when the table lacks it. */
export function translator(table: Record<string, string>) {
  return (key: string, params?: Record<string, string | number | boolean>) =>
    (table[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params?.[name] ?? ""))
}
