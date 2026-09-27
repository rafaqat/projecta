export default function ServerError({ correlationId }: { correlationId?: string }) {
  return (
    <>
      <h1>Something went wrong</h1>
      {correlationId ? (
        <p>
          Quote this reference when reporting the problem: <code>{correlationId}</code>
        </p>
      ) : null}
    </>
  )
}
