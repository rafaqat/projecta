export function SafeHtml({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: html }} />
}
